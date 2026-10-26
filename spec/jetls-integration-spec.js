// Talks to the real `jetls`. Skipped unless JETLS_INTEGRATION=1.
//   JETLS_INTEGRATION=1 pulsar --test spec
// First run can be slow (JETLS precompiles); timeouts are generous.
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { encode, createParser } = require("./helpers/rpc");
const { resolveJetls, buildArgs } = require("../lib/launch");

const fixtures = path.join(__dirname, "fixtures");
const suite = process.env.JETLS_INTEGRATION ? describe : xdescribe;

suite("real JETLS", () => {
  let child, spawnError, init, configRequest;
  const write = (m) => child.stdin.write(encode({ jsonrpc: "2.0", ...m }));

  beforeEach(() => {
    init = configRequest = spawnError = undefined;
    child = spawn(resolveJetls({}), buildArgs({ threads: "auto" }), { cwd: fixtures });
    child.on("error", (e) => { spawnError = e.message; });
    child.stdout.on("data", createParser((msg) => {
      if (msg.id === 1 && msg.method === undefined) { init = msg; return; }
      if (msg.method === "workspace/configuration") {
        configRequest = msg;
        write({ id: msg.id, result: msg.params.items.map(() => ({ formatter: "JuliaFormatter" })) });
        return;
      }
      if (msg.id !== undefined && msg.method) write({ id: msg.id, result: null }); // other server->client requests
    }));
    write({
      id: 1, method: "initialize",
      params: {
        processId: process.pid,
        rootUri: pathToFileURL(fixtures).href,
        capabilities: { workspace: { configuration: true, didChangeConfiguration: { dynamicRegistration: false } } },
      },
    });
  });

  afterEach(() => { if (child) child.kill(); });

  it("answers `initialize` with capabilities", () => {
    waitsFor(() => init || spawnError, "initialize response", 180000);
    runs(() => {
      expect(spawnError).toBeUndefined();
      expect(init.result.capabilities).toBeDefined();
    });
  });

  it("pulls `workspace/configuration` for the \"jetls\" section", () => {
    waitsFor(() => init || spawnError, "initialize response", 180000);
    runs(() => {
      expect(spawnError).toBeUndefined();
      write({ method: "initialized", params: {} });
      // Mirrors main.js, which pushes a notification whenever settings change.
      write({ method: "workspace/didChangeConfiguration", params: { settings: { jetls: {} } } });
    });
    waitsFor(() => configRequest, "JETLS to request workspace/configuration", 60000);
    runs(() => expect(configRequest.params.items[0].section).toBe("jetls"));
  });
});
