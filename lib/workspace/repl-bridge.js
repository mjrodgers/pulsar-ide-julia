// Gets the REPL started in Pulsar's terminal to connect back to us: listens on a local socket and writes a tiny
// startup file for `julia -L`, which loads julia/workspace.jl and tells it where to connect.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { pipePath } = require("../channel");
const { ReplWorkspaceSource } = require("./repl-source");

const HELPER = path.join(__dirname, "..", "..", "julia", "workspace.jl");
let counter = 0;

const { rawString } = require("../julia-string");

function bootstrapSource(helper, pipe) {
  return `include(${rawString(helper)})\nMain.var"#PulsarIDEWorkspace".start(${rawString(pipe)})\n`;
}

class ReplBridge {
  constructor({ helper = HELPER, tmpdir = os.tmpdir(), makePipe = pipePath, createServer = net.createServer } = {}) {
    this.helper = helper;
    this.tmpdir = tmpdir;
    this.makePipe = makePipe;
    this.createServer = createServer;
    this.server = null;
    this.file = null;
    this.source = null;
    this.connectListeners = new Set();
    this.disconnectListeners = new Set();
  }

  onDidConnect(fn) { this.connectListeners.add(fn); return { dispose: () => this.connectListeners.delete(fn) }; }
  onDidDisconnect(fn) { this.disconnectListeners.add(fn); return { dispose: () => this.disconnectListeners.delete(fn) }; }

  // Call before starting a REPL. Returns {loadFile}: the file to pass to `julia -L`.
  async prepare() {
    this.closeServer();
    const address = this.makePipe();
    const server = this.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => { server.removeListener("error", reject); resolve(); });
    });
    this.server = server;
    this.address = address;

    this.file = path.join(this.tmpdir, `pulsar-ide-julia-workspace-${process.pid}-${++counter}.jl`);
    fs.writeFileSync(this.file, bootstrapSource(this.helper, address));
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
