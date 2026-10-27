// Talks to the real `jetls`. Skipped unless JETLS_INTEGRATION=1.
//   JETLS_INTEGRATION=1 pulsar --test spec
// First run can be slow (JETLS precompiles); timeouts are generous.
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { encode, createParser } = require("./helpers/rpc");
const { deferred } = require("./helpers/deferred");
const { useTimeout } = require("./helpers/timeout");
const { resolveJetls, buildArgs } = require("../lib/launch");

const fixtures = path.join(__dirname, "fixtures");
const suite = process.env.JETLS_INTEGRATION ? describe : xdescribe;
const VERY_SLOW = 180000;

suite("real JETLS", () => {
  let child, init, configRequest;
  useTimeout(VERY_SLOW);
  const write = (m) => child.stdin.write(encode({ jsonrpc: "2.0", ...m }));

  beforeEach(() => {
    init = deferred();
    configRequest = deferred();
    child = spawn(resolveJetls({}), buildArgs({ threads: "auto" }), { cwd: fixtures });
    child.on("error", (e) => { init.reject(e); configRequest.reject(e); });
    child.stdout.on("data", createParser((msg) => {
      if (msg.id === 1 && msg.method === undefined) { init.resolve(msg); return; }
      if (msg.method === "workspace/configuration") {
        configRequest.resolve(msg);
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

  it("answers `initialize` with capabilities", async () => {
    const response = await init.promise;
    expect(response.result.capabilities).toBeDefined();
  });

  it('pulls `workspace/configuration` for the "jetls" section', async () => {
    await init.promise;
    write({ method: "initialized", params: {} });
    // Mirrors the fork, which pushes a notification whenever settings change.
    write({ method: "workspace/didChangeConfiguration", params: { settings: { jetls: {} } } });
    const request = await configRequest.promise;
    expect(request.params.items[0].section).toBe("jetls");
  });
});

// Real JETLS over `--pipe-connect`, the transport the package uses by default.
suite("real JETLS over a pipe", () => {
  const { connectViaPipe } = require("../lib/channel");
  let child, socket;
  useTimeout(VERY_SLOW);

  afterEach(() => {
    if (socket) socket.destroy();
    if (child) child.kill();
  });

  it("connects to our socket and answers `initialize`", async () => {
    ({ child, socket } = await connectViaPipe((pipe) =>
      spawn(resolveJetls({}), [...buildArgs({ threads: "auto" }), `--pipe-connect=${pipe}`], { cwd: fixtures })));

    const reply = deferred();
    socket.on("data", createParser((msg) => { if (msg.id === 1) reply.resolve(msg); }));
    socket.write(encode({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { processId: process.pid, rootUri: pathToFileURL(fixtures).href, capabilities: {} },
    }));
    expect((await reply.promise).result.capabilities).toBeDefined();
  });
});
