// A tiny stand-in for JETLS so specs run without Julia installed.
//  * Speaks LSP over stdio, or over a socket when started with `--pipe-connect=<path>`.
//  * After `initialized` it pulls `workspace/configuration` like JETLS does, and if
//    FAKE_SERVER_LOG is set it writes the client's answer there.
//  * With FAKE_SERVER_NOISE set it prints non-LSP text to stdout before every message,
//    like a package banner would. Harmless over a pipe, fatal over stdio.
const fs = require("fs");
const net = require("net");
const { encode, createParser } = require("../helpers/rpc");

const pipeArg = process.argv.slice(2).find((a) => a.startsWith("--pipe-connect="));
let input = process.stdin;
let output = process.stdout;
if (pipeArg) {
  const socket = net.connect(pipeArg.slice("--pipe-connect=".length));
  input = socket;
  output = socket;
}

const NOISE = !!process.env.FAKE_SERVER_NOISE;
const CONFIG_REQUEST_ID = "fake-config-1";

const send = (m) => {
  if (NOISE) process.stdout.write("fake-package 1.2.3: loading... (this is not LSP)\n");
  output.write(encode({ jsonrpc: "2.0", ...m }));
};

input.on("data", createParser((msg) => {
  if (msg.id === CONFIG_REQUEST_ID && msg.method === undefined) { // response to our request
    if (process.env.FAKE_SERVER_LOG) fs.writeFileSync(process.env.FAKE_SERVER_LOG, JSON.stringify(msg.result));
    return;
  }
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: {
        capabilities: { textDocumentSync: 1, hoverProvider: true },
        serverInfo: { name: "fake-jetls" },
      } });
    case "initialized":
      return send({ id: CONFIG_REQUEST_ID, method: "workspace/configuration", params: { items: [{ section: "jetls" }] } });
    case "shutdown":
      return send({ id: msg.id, result: null });
    case "exit":
      return process.exit(0);
    case "textDocument/didOpen":
      return send({ method: "textDocument/publishDiagnostics", params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 2, source: "fake-jetls", message: "fake diagnostic",
        }],
      } });
  }
  if (msg.id !== undefined && msg.method) send({ id: msg.id, result: null });
}));
