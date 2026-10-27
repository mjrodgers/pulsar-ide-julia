// A small Debug Adapter Protocol client over any duplex byte stream (here: a pipe the
// Julia adapter connects to). Requests return promises; events are delivered by name.
const { EventEmitter } = require("events");
const { encode, createParser } = require("./framing");

class DapError extends Error {
  constructor(message, command, body) {
    super(message);
    this.name = "DapError";
    this.command = command;
    this.body = body;
  }
}

class DapClient extends EventEmitter {
  constructor(stream, { requestTimeout = 120000 } = {}) {
    super();
    this.stream = stream;
    this.requestTimeout = requestTimeout;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;

    const parse = createParser((m) => this.handle(m), (e) => this.emit("protocol-error", e));
    stream.on("data", parse);
    stream.on("error", (e) => this.shutdown(e));
    stream.on("close", () => this.shutdown());
  }

  request(command, args, { timeout = this.requestTimeout } = {}) {
    if (this.closed) return Promise.reject(new DapError("The debug connection is closed.", command));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(`Timed out waiting for '${command}'.`, command));
      }, timeout) : null;
      this.pending.set(seq, { command, resolve, reject, timer });
      this.stream.write(encode({ seq, type: "request", command, arguments: args }));
    });
  }

  // Subscribe to an adapter event by name (e.g. "stopped"). Returns an unsubscribe function.
  onEvent(name, listener) {
    this.on(`event:${name}`, listener);
    return () => this.removeListener(`event:${name}`, listener);
  }

  // Resolves with the body of the next `name` event.
  waitForEvent(name) {
    return new Promise((resolve) => this.once(`event:${name}`, resolve));
  }

  handle(m) {
    if (m.type === "response") {
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      if (p.timer) clearTimeout(p.timer);
      if (m.success) p.resolve(m.body || {});
      else p.reject(new DapError(m.message || `'${p.command}' failed`, p.command, m.body));
    } else if (m.type === "event") {
      this.emit(`event:${m.event}`, m.body || {});
      this.emit("event", m.event, m.body || {});
    } else if (m.type === "request") {
      // Reverse requests (runInTerminal, startDebugging) are not supported.
      this.stream.write(encode({
        seq: ++this.seq, type: "response", request_seq: m.seq, success: false,
        command: m.command, message: `Unsupported request '${m.command}'`,
      }));
    }
  }

  shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [seq, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(error || new DapError("The debug connection closed.", p.command));
      this.pending.delete(seq);
    }
    this.emit("close", error);
  }

  close() {
    try { this.stream.end(); } catch (e) { /* already closed */ }
    this.shutdown();
  }
}

module.exports = { DapClient, DapError };
