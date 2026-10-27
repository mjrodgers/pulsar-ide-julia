// Talking to JETLS over a local socket instead of stdio.
//
// JETLS's docs warn that in stdio mode any `println(stdout, ...)` from the code it loads
// (a package's startup banner, a stray debug print) corrupts the protocol stream. Their
// recommendation, and the VS Code client's default, is `--pipe-connect=<path>`: we listen
// on a Unix domain socket / Windows named pipe, and the server connects to it.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

let counter = 0;

// Unix socket paths are limited to ~100 bytes, so keep the name short.
function pipePath({ platform = process.platform, tmpdir = os.tmpdir(), pid = process.pid } = {}) {
  const name = `pulsar-jetls-${pid}-${++counter}`;
  return platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(tmpdir, `${name}.sock`);
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => { server.removeListener("error", reject); resolve(); });
  });
}

// Resolves with the first connection; rejects if the child fails or exits first.
function waitForConnection(server, child) {
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      server.removeListener("connection", onConnection);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      fn(value);
    };
    const onConnection = (socket) => settle(resolve, socket);
    const onError = (err) => settle(reject, err);
    const onExit = (code, signal) =>
      settle(reject, new Error(`The server exited (code ${code}, signal ${signal}) before connecting to the pipe.`));
    server.on("connection", onConnection);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

// `spawnServer(pipe)` must start the server with `--pipe-connect=<pipe>` and return the
// child process. No timeout: a first start can spend minutes precompiling. The wait ends
// when the server connects, fails to start, or exits.
async function connectViaPipe(spawnServer, pipeOptions) {
  const address = pipePath(pipeOptions);
  const server = net.createServer();
  await listen(server, address);

  let child;
  try {
    child = spawnServer(address);
    const socket = await waitForConnection(server, child);
    return { child, socket };
  } catch (err) {
    if (child) { try { child.kill(); } catch (e) { /* already gone */ } }
    throw err;
  } finally {
    server.close(); // stops accepting; the established connection stays open
    if (!address.startsWith("\\\\")) fs.unlink(address, () => {});
  }
}

// The fork reads `lsProcess.stdin`/`stdout` in its stdio mode (and has a single shared
// `socket` field for its socket mode, which concurrent servers would clobber). Hand it
// the child with stdin/stdout replaced by the socket; everything else passes through.
function withSocketStdio(child, socket) {
  return new Proxy(child, {
    get(target, prop) {
      if (prop === "stdin" || prop === "stdout") return socket;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The real stdout is unused in pipe mode, but must be drained: a full OS pipe buffer
// would block a server that prints a lot.
function drainStdout(child, onText) {
  if (!child.stdout) return;
  child.stdout.on("data", (chunk) => { if (onText) onText(String(chunk)); });
}

module.exports = { pipePath, connectViaPipe, withSocketStdio, drainStdout };
