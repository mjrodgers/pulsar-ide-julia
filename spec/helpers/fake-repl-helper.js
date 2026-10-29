// Speaks the protocol of julia/workspace.jl from Node, so the REPL source and bridge can be tested without Julia.
// The data mirrors what test_workspace.jl expects the real helper to produce.
const net = require("net");
const os = require("os");
const path = require("path");
const { setImmediate } = require("timers");

let counter = 0;
const tmpPath = () => path.join(os.tmpdir(), `fake-ws-${process.pid}-${++counter}.sock`);

class FakeHelper {
  constructor(socket) {
    this.socket = socket;
    this.requests = []; // [{id, op, arg}]
    this.generation = 0; // changes what `x` is, to see refreshes
    this.refs = new Map();
    this.nextRef = 1;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      this.buffer += d;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
    socket.on("error", () => {});
  }

  send(obj) { if (!this.socket.destroyed) this.socket.write(JSON.stringify(obj) + "\n"); }
  changed() { this.send({ event: "changed" }); }
  busyEvent() { this.send({ event: "busy" }); }

  ref(children) { const r = this.nextRef++; this.refs.set(r, children); return r; }
  item(name, value, type, kind, children) {
    return { name, value, type, kind, ref: children ? this.ref(children) : 0, truncated: false };
  }

  listing() {
    this.refs.clear();
    return [
      this.item("x", String(42 + this.generation), "Int64", "variable"),
      this.item("v", "[1, 2, 3]", "3-element Vector{Int64}", "variable", () => [1, 2, 3].map((n, i) => this.item(`[${i + 1}]`, String(n * (this.generation + 1)), "Int64", "value"))),
      this.item("C", "3.5", "Float64", "constant"),
      this.item("Foo", "Foo", "DataType", "type"),
      this.item("f", "f", "typeof(f)", "function"),
      this.item("Base", "Base", "Module", "module"),
    ];
  }

  handle(line) {
    const [idText, op, ...rest] = line.split("\t");
    const id = Number(idText);
    const arg = rest.join("\t");
    this.requests.push({ id, op, arg });
    if (this.options && this.options.silent) return;
    // `busy`: the REPL is running something; values are not read (see julia/workspace.jl).
    if (this.busy && (op === "ls" || op === "children" || op === "modules")) {
      return this.send({ id, ok: false, busy: true, error: "The REPL is busy; the workspace is read again when it is free." });
    }
    if (op === "interrupt") {
      if (!this.busy) return this.send({ id, ok: false, error: "nothing is running" });
      this.interrupts = (this.interrupts || 0) + 1;
      return this.send({ id, ok: true, items: [] });
    }
    if (this.failLs && op === "ls") return this.send({ id, ok: false, error: this.failLs });
    if (op === "ls") {
      return setImmediate(() => this.send({ id, ok: true, module: arg || "Main", items: this.listing() }));
    }
    if (op === "children") {
      const make = this.refs.get(Number(arg));
      if (!make) return this.send({ id, ok: false, error: "this value is out of date; refresh the workspace" });
      return this.send({ id, ok: true, items: make() });
    }
    if (op === "modules") {
      return this.send({ id, ok: true, names: this.moduleNames || ["Main", "Main.Base", "Main.Foo", "Main.Foo.Bar"] });
    }
    if (op === "eval") {
      if (this.options && this.options.failEval) return this.send({ id, ok: false, error: "cannot evaluate this request" });
      if (this.options && this.options.silentEval) return undefined;
      this.evals = this.evals || [];
      const [n, ...flags] = arg.split(" ");
      this.evals.push(Number(n));
      // The result can come before the answer that the request was queued (the code ran at once).
      if (flags.includes("result")) this.send({ event: "result", id: Number(n), ms: 3, kind: "value", text: "42" });
      return this.send({ id, ok: true, items: [] });
    }
    if (op === "ping") return this.send({ id, ok: true, items: [] });
    return this.send({ id, ok: false, error: `unknown request '${op}'` });
  }

  count(op) { return this.requests.filter((r) => r.op === op).length; }
}

async function startFakeHelper(options = {}) {
  const address = tmpPath();
  const server = net.createServer();
  const helpers = [];
  server.on("connection", (socket) => { const h = new FakeHelper(socket); h.options = options; helpers.push(h); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  return {
    address,
    helpers,
    get helper() { return helpers[0]; },
    connect: () => new Promise((resolve, reject) => {
      const socket = net.connect(address);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); helpers.forEach((h) => h.socket.destroy()); }),
  };
}

module.exports = { FakeHelper, startFakeHelper };
