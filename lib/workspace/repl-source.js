// A workspace data source for the Julia REPL, the counterpart of DapSession for the debugger: the same `state`
// shape and the same methods (loadVariables, ...), so WorkspaceModel and the pane need not care which they follow.
//
// It talks to julia/workspace.jl, which runs inside the REPL's Julia process (see that file for the protocol).
const { EventEmitter } = require("events");
const { StringDecoder } = require("string_decoder");
// Node's own timers: Pulsar's spec runner replaces the window's with a mock clock.
const { setTimeout, clearTimeout } = require("timers");

const toVariable = (it) => ({
  name: String(it.name),
  value: String(it.value),
  type: it.type || "",
  ref: it.ref || 0,
  kind: it.kind || "",
  truncated: !!it.truncated,
});

class ReplWorkspaceSource extends EventEmitter {
  constructor(socket, { module: mod = "Main", requestTimeout = 15000, refreshDelay = 150 } = {}) {
    super();
    this.socket = socket;
    this.module = mod;
    this.requestTimeout = requestTimeout;
    this.refreshDelay = refreshDelay;
    // status "live": always current, never "stopped"; there are no frames. `busy`: the REPL is running something, so
    // its values are not read until it is done (the rows shown are from before). `problem`: why the last reading failed.
    this.state = { status: "live", loading: false, reason: undefined, frames: [], frameId: undefined, contexts: [], busy: false, problem: undefined };
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.refreshTimer = null;
    this.refreshCount = 0;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => {}); // "close" follows
    this.refresh();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  // --- wire --------------------------------------------------------------------------------------
  onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (e) { this.emit("problem", new Error(`unreadable answer: ${line.slice(0, 80)}`)); continue; }
      this.onMessage(message);
    }
  }

  onMessage(m) {
    if (m.event === "changed") return this.scheduleRefresh();
    if (m.event === "busy") return this.state.busy ? undefined : this.setState({ busy: true });
    const p = this.pending.get(m.id);
    if (!p) return undefined;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m);
    else if (m.busy) p.reject(Object.assign(new Error(m.error || "The Julia REPL is busy."), { code: "busy" }));
    else p.reject(new Error(m.error || "the Julia REPL could not answer"));
    return undefined;
  }

  request(op, arg = "") {
    if (this.closed) return Promise.reject(new Error("The Julia REPL is no longer connected."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`The Julia REPL did not answer '${op}' in time (is it busy?).`), { code: "timeout" }));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${id}\t${op}\t${String(arg).replace(/[\t\r\n]/g, " ")}\n`);
    });
  }

  // --- data --------------------------------------------------------------------------------------
  scheduleRefresh() {
    if (this.closed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(); }, this.refreshDelay);
  }

  // Reads the watched module again. Replaces `contexts`, so the model re-fetches whatever the user has expanded.
  async refresh() {
    if (this.closed) return;
    const mine = ++this.refreshCount;
    try {
      const body = await this.request("ls", this.module);
      if (mine !== this.refreshCount || this.closed) return;
      this.setState({
        contexts: [{ name: body.module || this.module, ref: 0, lazy: false, items: (body.items || []).map(toVariable) }],
        busy: false,
        problem: undefined,
      });
    } catch (e) {
      if (mine !== this.refreshCount || this.closed) return;
      // Busy: the helper announces a change when the REPL is free again, and that reads the module again.
      // No answer in time: the REPL is running something and the helper has no interactive thread to answer from.
      if (e && (e.code === "busy" || e.code === "timeout")) this.setState({ busy: true });
      else this.setState({ busy: false, problem: (e && e.message) || String(e) });
      this.emit("problem", e);
    }
  }

  setModule(path) {
    this.module = path || "Main";
    return this.refresh();
  }

  // The paths of the modules the REPL has loaded, e.g. ["Main", "Main.Foo", "Main.Foo.Bar"].
  async modules() {
    const body = await this.request("modules");
    return (body.names || []).map(String);
  }

  // Asks the helper to evaluate request `fileId` (see ReplBridge#evalCode). It answers once the request is queued.
  async requestEval(fileId) {
    await this.request("eval", fileId);
  }

  // Interrupts what the REPL is running, as Ctrl-C in its terminal would (which does not reach code sent from
  // Pulsar). Rejects with "nothing is running" when the REPL is free.
  async interrupt() {
    await this.request("interrupt");
  }

  async loadVariables(ref) {
    if (!ref) return [];
    const body = await this.request("children", ref);
    return (body.items || []).map(toVariable);
  }

  // The interface the model shares with DapSession; a REPL has no frames and no lazy scopes.
  async loadScope() {}
  async selectFrame() {}

  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("The Julia REPL closed.")); }
    this.pending.clear();
    this.setState({ status: "ended", loading: false, contexts: [] });
    this.emit("ended");
  }

  close() {
    try { this.socket.destroy(); } catch (e) { /* already closed */ }
    this.finish();
  }
}

module.exports = { ReplWorkspaceSource };
