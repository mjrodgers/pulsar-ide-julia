// A scriptable fake Debug Adapter, used by specs in place of DebugAdapter.jl.
//
// It follows the real sequence (initialize -> `initialized` event -> breakpoints ->
// configurationDone -> answer to launch) and, after configurationDone, stops on entry or at a
// breakpoint. Each stop has two frames (`inner` at `line`, `outer` at line 20); the local `x`
// counts the steps taken, so a UI that fails to refresh is easy to spot.
const net = require("net");
// Node's own timers: Pulsar's spec runner replaces the window's setTimeout/setImmediate with a mock clock.
const { setImmediate } = require("timers");
const os = require("os");
const path = require("path");
const { encode, createParser } = require("../../lib/dap/framing");

let counter = 0;
const tmpPath = () => path.join(os.tmpdir(), `fake-dap-${process.pid}-${++counter}.sock`);

class FakeAdapter {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.options = options;
    this.requests = []; // every request received, in order
    this.breakpoints = new Map();
    this.step = 0;
    this.line = 3;
    this.seq = 0;
    this.launchRequest = null;
    socket.on("data", createParser((m) => this.handle(m)));
  }

  send(m) { if (!this.socket.destroyed) this.socket.write(encode({ seq: ++this.seq, ...m })); }
  respond(req, body, extra = {}) { this.send({ type: "response", request_seq: req.seq, command: req.command, success: true, body, ...extra }); }
  fail(req, message) { this.send({ type: "response", request_seq: req.seq, command: req.command, success: false, message }); }
  event(event, body = {}) { this.send({ type: "event", event, body }); }

  get file() { return (this.launchRequest && this.launchRequest.arguments.program) || "/work/script.jl"; }
  commands() { return this.requests.map((r) => r.command); }

  stopped(reason) {
    this.event("stopped", this.options.omitThreadId ? { reason, allThreadsStopped: true } : { reason, threadId: 1, allThreadsStopped: true });
  }

  handle(req) {
    if (req.type !== "request") return;
    this.requests.push(req);
    const a = req.arguments || {};
    switch (req.command) {
      case "initialize":
        this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          exceptionBreakpointFilters: [{ filter: "error", label: "Errors" }],
        });
        return this.event("initialized");
      case "launch":
      case "attach":
        this.launchRequest = req;
        if (this.options.failLaunch) return this.fail(req, this.options.failLaunch);
        if (this.options.answerLaunchEarly) this.respond(req, {});
        return undefined;
      case "setBreakpoints":
        this.breakpoints.set(a.source.path, a.breakpoints || []);
        return this.respond(req, { breakpoints: (a.breakpoints || []).map((b, i) => ({ id: i + 1, verified: true, line: b.line })) });
      case "setExceptionBreakpoints":
        return this.respond(req, {});
      case "configurationDone": {
        this.respond(req, {});
        if (!this.options.answerLaunchEarly && this.launchRequest && !this.options.failLaunch) this.respond(this.launchRequest, {});
        const any = [...this.breakpoints.values()].some((l) => l.length > 0);
        const entry = this.launchRequest && this.launchRequest.arguments.stopOnEntry;
        if (any) { this.line = [...this.breakpoints.values()].flat()[0].line; setImmediate(() => this.stopped("breakpoint")); }
        else if (entry) setImmediate(() => this.stopped("entry"));
        else if (this.options.finishImmediately) setImmediate(() => { this.event("exited", { exitCode: 0 }); this.event("terminated"); });
        return undefined;
      }
      case "threads":
        return this.respond(req, { threads: [{ id: 1, name: "main" }] });
      case "stackTrace":
        return this.respond(req, { stackFrames: [
          { id: 100, name: "inner", source: { path: this.file }, line: this.line, column: 1 },
          { id: 101, name: "outer", source: { path: this.file }, line: 20, column: 1 },
        ], totalFrames: 2 });
      case "scopes":
        return this.respond(req, { scopes: [
          { name: "Local", variablesReference: a.frameId * 10 + 1, expensive: false },
          { name: "Global", variablesReference: a.frameId * 10 + 2, expensive: true },
        ] });
      case "variables":
        return this.respond(req, { variables: this.variables(a.variablesReference) });
      case "next": case "stepIn": case "stepOut":
        this.step++; this.line++;
        this.respond(req, {});
        return setImmediate(() => this.stopped("step"));
      case "continue":
        this.respond(req, { allThreadsContinued: true });
        return setImmediate(() => { this.event("exited", { exitCode: 0 }); this.event("terminated"); });
      case "evaluate":
        return this.respond(req, { result: `value of ${a.expression}`, type: "String", variablesReference: 0 });
      case "terminate": case "disconnect":
        this.respond(req, {});
        return setImmediate(() => this.socket.end());
      default:
        return this.fail(req, `unsupported: ${req.command}`);
    }
  }

  variables(ref) {
    switch (ref) {
      case 1001: return [
        { name: "x", value: String(this.step), type: "Int64", variablesReference: 0 },
        { name: "v", value: "[1, 2, 3]", type: "Vector{Int64}", variablesReference: 5000 },
        { name: "s", value: '"hello"', type: "String", variablesReference: 0 },
      ];
      case 1011: return [{ name: "y", value: "7.5", type: "Float64", variablesReference: 0 }];
      case 1002: case 1012: return [{ name: "G", value: "42", type: "Int64", variablesReference: 0 }];
      case 5000: return [1, 2, 3].map((n) => ({ name: String(n), value: String(n), type: "Int64", variablesReference: 0 }));
      default: return [];
    }
  }
}

// Starts a server; resolves with { adapter (the first connection's FakeAdapter), connect(), close() }.
// `connect()` returns a client-side socket.
async function startFakeAdapter(options = {}) {
  const address = tmpPath();
  const server = net.createServer();
  const adapters = [];
  server.on("connection", (socket) => adapters.push(new FakeAdapter(socket, options)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  return {
    address,
    adapters,
    get adapter() { return adapters[0]; },
    connect: () => new Promise((resolve, reject) => {
      const socket = net.connect(address);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); adapters.forEach((a) => a.socket.destroy()); }),
  };
}

module.exports = { FakeAdapter, startFakeAdapter };
