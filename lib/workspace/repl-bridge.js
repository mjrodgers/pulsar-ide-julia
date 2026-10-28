// Gets the REPL started in Pulsar's terminal to connect back to us: listens on a local socket and writes a tiny
// startup file for `julia -L`, which loads julia/workspace.jl and tells it where to connect.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { pipePath } = require("../channel");
const { ReplWorkspaceSource } = require("./repl-source");
// Node's own timers: Pulsar's spec runner replaces the window's with a mock clock.
const { setTimeout, clearTimeout } = require("timers");

const HELPER = path.join(__dirname, "..", "..", "julia", "workspace.jl");
let counter = 0;

const { rawString } = require("../julia-string");

function bootstrapSource(helper, pipe, evalDir) {
  const dir = evalDir ? `; evaldir=${rawString(evalDir)}` : "";
  return `include(${rawString(helper)})\nMain.var"#PulsarIDEWorkspace".start(${rawString(pipe)}${dir})\n`;
}

class ReplBridge {
  constructor({ helper = HELPER, tmpdir = os.tmpdir(), makePipe = pipePath, createServer = net.createServer, connectTimeout = 20000 } = {}) {
    this.helper = helper;
    this.tmpdir = tmpdir;
    this.makePipe = makePipe;
    this.createServer = createServer;
    this.server = null;
    this.file = null;
    this.source = null;
    this.connectTimeout = connectTimeout;
    this.gaveUp = false; // the helper did not connect in time; the REPL is typed into as it is until it does
    this.evalDir = null;
    this.evalCount = 0;
    this.waiters = new Set();
    this.connectListeners = new Set();
    this.disconnectListeners = new Set();
  }

  onDidConnect(fn) { this.connectListeners.add(fn); return { dispose: () => this.connectListeners.delete(fn) }; }
  onDidDisconnect(fn) { this.disconnectListeners.add(fn); return { dispose: () => this.disconnectListeners.delete(fn) }; }

  // Call before starting a REPL. Returns {loadFile}: the file to pass to `julia -L`.
  async prepare() {
    this.closeServer();
    this.gaveUp = false;
    const address = this.makePipe();
    const server = this.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    this.address = address;

    this.evalDir = fs.mkdtempSync(path.join(this.tmpdir, `pulsar-ide-julia-eval-${process.pid}-`));
    this.file = path.join(this.tmpdir, `pulsar-ide-julia-workspace-${process.pid}-${++counter}.jl`);
    fs.writeFileSync(this.file, bootstrapSource(this.helper, address, this.evalDir));
    return { loadFile: this.file };
  }

  accept(socket) {
    if (this.source) this.source.close();
    const source = new ReplWorkspaceSource(socket);
    this.source = source;
    this.removeFile(); // Julia has read it by now
    source.on("ended", () => {
      if (this.source !== source) return;
      this.source = null;
      for (const fn of [...this.disconnectListeners]) fn(source);
    });
    for (const fn of [...this.connectListeners]) fn(source);
    for (const wake of [...this.waiters]) wake(source);
  }

  // --- code for the REPL to evaluate ----------------------------------------------------------
  // The Julia helper defines `__pulsar_eval__(id)`, which reads `<evalDir>/<id>.jl`: the module path, the source
  // file, the first line number, then the code. Typing that one short call into the REPL evaluates the code in its
  // module with the editor's file name and line numbers (see julia/workspace.jl).
  canEval() {
    return !!this.evalDir && (!this.gaveUp || !!this.source);
  }

  // Resolves with the connected source, or null if the REPL's helper did not connect within `timeout` ms (it may
  // never: an old Julia, an error in the startup file). After that, later calls do not wait again.
  whenConnected(timeout = this.connectTimeout) {
    if (this.source) return Promise.resolve(this.source);
    if (!this.server || this.gaveUp) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (value) => { clearTimeout(timer); this.waiters.delete(done); resolve(value); };
      const timer = setTimeout(() => { if (this.waiters.has(done)) this.gaveUp = true; done(null); }, timeout);
      this.waiters.add(done);
    });
  }

  // Stores the request and returns the call to type into the REPL.
  writeEval({ module: modulePath = "Main", file = "", line = 1, code }) {
    if (!this.evalDir) throw new Error("the Julia helper is not set up for this REPL");
    const id = ++this.evalCount;
    const text = [modulePath, String(file).replace(/[\r\n]/g, " "), String(line), String(code).replace(/\r\n?/g, "\n")].join("\n");
    fs.writeFileSync(path.join(this.evalDir, `${id}.jl`), text);
    return `__pulsar_eval__(${id})`;
  }

  removeFile() {
    if (!this.file) return;
    try { fs.unlinkSync(this.file); } catch (e) { /* already gone */ }
    this.file = null;
  }

  closeServer() {
    if (this.server) {
      try { this.server.close(); } catch (e) { /* not listening */ }
      if (this.address && !this.address.startsWith("\\\\")) fs.unlink(this.address, () => {});
    }
    this.server = null;
    this.removeFile();
    if (this.evalDir) {
      try { fs.rmSync(this.evalDir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
      this.evalDir = null;
    }
    for (const wake of [...this.waiters]) wake(null);
  }

  dispose() {
    this.closeServer();
    if (this.source) this.source.close();
    this.source = null;
    this.connectListeners.clear();
    this.disconnectListeners.clear();
  }
}

module.exports = { ReplBridge, bootstrapSource, HELPER };
