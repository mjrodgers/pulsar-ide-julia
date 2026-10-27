// A debug session: drives the protocol (initialize/launch/breakpoints/stepping) and turns
// each stop into a plain state object for the UI:
//
//   { status: "idle" | "starting" | "running" | "stopped" | "ended",
//     reason, threadId,
//     frames: [{ id, name, file, line, column }],      // line is 1-based
//     frameId,
//     contexts: [{ name, ref, lazy, items: [{ name, value, type, ref }] }] }   // scopes + variables
//
// `ref` > 0 means the value has children, fetched with loadVariables(ref).
const { EventEmitter } = require("events");

const CLIENT_INFO = {
  clientID: "pulsar-ide-julia",
  clientName: "Pulsar (pulsar-ide-julia)",
  adapterID: "julia",
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: "path",
  supportsVariableType: true,
  supportsVariablePaging: false,
};

const MAX_VARIABLES = 500; // per request; huge arrays are cut off instead of fetched whole

function toVariable(v) {
  return {
    name: String(v.name),
    value: v.value == null ? "" : String(v.value),
    type: v.type || "",
    ref: v.variablesReference || 0,
    evaluateName: v.evaluateName,
    truncated: false,
  };
}

class DapSession extends EventEmitter {
  constructor(client, { logger = console } = {}) {
    super();
    this.client = client;
    this.logger = logger;
    this.capabilities = {};
    this.state = { status: "idle", loading: false, frames: [], contexts: [] };
    this.stopCounter = 0;
    this.ended = false;

    client.onEvent("stopped", (body) => this.onStopped(body));
    client.onEvent("continued", () => this.setState({ status: "running", reason: undefined }));
    client.onEvent("terminated", () => this.finish());
    client.onEvent("exited", (body) => this.emit("exited", body.exitCode));
    client.onEvent("output", (body) => this.emit("output", { category: body.category || "console", text: String(body.output || "") }));
    client.on("close", () => this.finish());
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  finish() {
    if (this.ended) return;
    this.ended = true;
    this.stopCounter++; // abandon any refresh in flight
    this.setState({ status: "ended", loading: false, frames: [], frameId: undefined, contexts: [], reason: undefined });
    this.emit("ended");
  }

  // breakpoints: Map<file, [{line, condition}]>; exceptionFilters: string[] (adapter's filter ids)
  async start({ request = "launch", args = {}, breakpoints = new Map(), exceptionFilters = [] } = {}) {
    this.setState({ status: "starting" });
    const initialized = this.client.waitForEvent("initialized");
    this.capabilities = await this.client.request("initialize", CLIENT_INFO);

    // Adapters answer `launch` only after `configurationDone`, so do not await it yet.
    const launched = this.client.request(request, args);
    launched.catch(() => {}); // surfaced by the await below; avoid an unhandled rejection meanwhile

    await Promise.race([initialized, launched]);
    for (const [file, list] of breakpoints) await this.setBreakpoints(file, list);
    if (exceptionFilters.length && this.capabilities.exceptionBreakpointFilters) {
      await this.client.request("setExceptionBreakpoints", { filters: exceptionFilters });
    }
    if (this.capabilities.supportsConfigurationDoneRequest !== false) {
      await this.client.request("configurationDone", {});
    }
    await launched;
    if (this.state.status === "starting") this.setState({ status: "running" });
  }

  // Replaces all breakpoints of one file. Returns the adapter's verdicts.
  async setBreakpoints(file, list) {
    const body = await this.client.request("setBreakpoints", {
      source: { path: file },
      breakpoints: list.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
    });
    return body.breakpoints || [];
  }

  async onStopped(body) {
    const stop = ++this.stopCounter;
    // `loading` is true until the frames and variables for this stop have arrived; the previous stop's
    // data stays in the state meanwhile, so a UI can dim it instead of flashing empty.
    this.setState({ status: "stopped", reason: body.reason, threadId: body.threadId, loading: true });
    try {
      let threadId = body.threadId;
      if (threadId == null) {
        const { threads = [] } = await this.client.request("threads") // takes no arguments at all (DebugAdapter.jl declares them as Nothing);
        threadId = threads[0] && threads[0].id;
        if (stop === this.stopCounter) this.setState({ threadId });
      }
      const { stackFrames = [] } = await this.client.request("stackTrace", { threadId, startFrame: 0, levels: 50 });
      if (stop !== this.stopCounter) return;
      const frames = stackFrames.map((f) => ({
        id: f.id, name: f.name,
        file: f.source && (f.source.path || f.source.name),
        line: f.line, column: f.column,
      }));
      this.setState({ frames, frameId: frames[0] && frames[0].id, contexts: [] });
      if (frames[0]) await this.loadFrame(frames[0].id, stop);
    } catch (e) {
      this.logger.warn("Could not read the debugger state", e);
    } finally {
      if (stop === this.stopCounter && this.state.loading) this.setState({ loading: false });
    }
  }

  async loadFrame(frameId, stop = this.stopCounter) {
    const { scopes = [] } = await this.client.request("scopes", { frameId });
    const contexts = await Promise.all(scopes.map(async (scope) => {
      const ctx = { name: scope.name, ref: scope.variablesReference, lazy: !!scope.expensive, items: [] };
      if (!ctx.lazy) ctx.items = await this.loadVariables(scope.variablesReference);
      return ctx;
    }));
    if (stop !== this.stopCounter) return;
    this.setState({ frameId, contexts });
  }

  async selectFrame(frameId) {
    if (this.state.status !== "stopped") return;
    const stop = this.stopCounter;
    this.setState({ frameId });
    await this.loadFrame(frameId, stop);
  }

  async loadScope(ref) {
    const stop = this.stopCounter;
    const items = await this.loadVariables(ref);
    if (stop !== this.stopCounter) return;
    this.setState({ contexts: this.state.contexts.map((c) => (c.ref === ref ? { ...c, lazy: false, items } : c)) });
  }

  async loadVariables(ref) {
    if (!ref) return [];
    const body = await this.client.request("variables", { variablesReference: ref, count: MAX_VARIABLES });
    const vars = (body.variables || []).map(toVariable);
    if (vars.length >= MAX_VARIABLES) vars[vars.length - 1].truncated = true;
    return vars;
  }

  // --- execution control ---------------------------------------------------------------------
  get threadId() { return this.state.threadId; }

  async resume(command) {
    if (this.state.status !== "stopped") return;
    this.stopCounter++; // whatever was being read is now stale
    this.setState({ status: "running", reason: undefined });
    await this.client.request(command, { threadId: this.threadId });
  }

  continue() { return this.resume("continue"); }
  stepOver() { return this.resume("next"); }
  stepIn() { return this.resume("stepIn"); }
  stepOut() { return this.resume("stepOut"); }

  async evaluate(expression, context = "repl") {
    const frameId = this.state.frameId;
    const body = await this.client.request("evaluate", { expression, frameId, context });
    return { value: String(body.result), type: body.type || "", ref: body.variablesReference || 0 };
  }

  async stop() {
    if (this.ended) return;
    try {
      if (this.capabilities.supportsTerminateRequest) await this.client.request("terminate", {}, { timeout: 3000 });
      else await this.client.request("disconnect", { terminateDebuggee: true }, { timeout: 3000 });
    } catch (e) { /* the adapter may close the connection instead of answering */ }
    this.client.close();
    this.finish();
  }
}

module.exports = { DapSession };
