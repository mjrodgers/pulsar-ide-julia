// The REAL startServerProcess over a pipe, against the fake server, which prints
// non-LSP text to stdout before every message (like a package banner). In stdio mode
// that corrupts the stream; over a pipe it must be harmless.
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("pipe channel through startServerProcess", () => {
  let client, spawnArgs;

  useTimeout(SLOW);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    spawnArgs = null;
    client = await activateJulia({
      prepare: (c) => spyOn(c, "spawn").and.callFake((exe, args, options) => {
        spawnArgs = args;
        const pipeArg = args.find((a) => a.startsWith("--pipe-connect="));
        return c.spawnChildNode([fakeServer, pipeArg], {
          cwd: options.cwd,
          env: Object.assign({}, process.env, { FAKE_SERVER_NOISE: "1" }),
        });
      }),
    });
  }));

  it("initializes even though the server prints non-LSP text to stdout", reportErrors(async () => {
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    // Resolves only once `initialize` has completed over the pipe.
    const connection = await client.getConnectionForEditor(atom.workspace.getActiveTextEditor());
    expect(connection).toBeTruthy();
    expect(spawnArgs.slice(-2)[0]).toBe("serve");
    expect(spawnArgs[spawnArgs.length - 1]).toMatch(/^--pipe-connect=/);
  }));
});
