// Activates the package against a fake server (no Julia needed).
// `startServerProcess` is stubbed AFTER activation and BEFORE a file is opened.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");

describe("activation", () => {
  let client;

  beforeEach(() => {
    atom.project.setPaths([fixtures]);
    waitsForPromise({ timeout: 20000 }, () => activateJulia().then((mainModule) => { client = mainModule; }));
  });

  it("registers the restart command", () => {
    const names = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) }).map((c) => c.name);
    expect(names).toContain("pulsar-ide-julia:restart-language-server");
  });

  it("starts a server for the project when a .jl file opens", () => {
    let startedFor = null;
    runs(() => {
      spyOn(client, "startServerProcess").andCallFake((projectPath) => {
        startedFor = projectPath;
        return client.spawnChildNode([fakeServer], { cwd: projectPath });
      });
    });
    waitsForPromise({ timeout: 20000 }, () => atom.workspace.open(path.join(fixtures, "hello.jl")));
    waitsFor(() => startedFor, "language server to start", 10000);
    runs(() => expect(startedFor).toBe(fixtures));
  });

  it("answers the server's workspace/configuration request from Pulsar settings", () => {
    const log = path.join(os.tmpdir(), `fake-jetls-config-${process.pid}.json`);
    runs(() => {
      try { fs.unlinkSync(log); } catch (e) { /* not there */ }
      atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
      atom.config.set("pulsar-ide-julia.debounce", 2.5);
      spyOn(client, "startServerProcess").andCallFake((projectPath) =>
        client.spawnChildNode([fakeServer], {
          cwd: projectPath,
          env: Object.assign({}, process.env, { FAKE_SERVER_LOG: log }),
        }));
    });
    waitsForPromise({ timeout: 20000 }, () => atom.workspace.open(path.join(fixtures, "hello.jl")));
    waitsFor(() => fs.existsSync(log), "server to receive our configuration answer", 10000);
    runs(() => {
      const [settings] = JSON.parse(fs.readFileSync(log, "utf8"));
      expect(settings).toEqual({ full_analysis: { debounce: 2.5 }, formatter: "JuliaFormatter" });
    });
  });

  it("resolves workspace/configuration sections from Pulsar settings", () => {
    let result;
    runs(() => {
      atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
      client.getWorkspaceConfiguration({ items: [{ section: "jetls" }, { section: "jetls.formatter" }, { section: "other" }] })
        .then((r) => { result = r; });
    });
    waitsFor(() => result, "configuration result", 2000);
    runs(() => {
      expect(result[0]).toEqual({ formatter: "JuliaFormatter" });
      expect(result[1]).toBe("JuliaFormatter");
      expect(result[2]).toBeUndefined();
    });
  });

  it("advertises workspace.configuration support", () => {
    const params = client.getInitializeParams(fixtures, { pid: 1 });
    expect(params.capabilities.workspace.configuration).toBe(true);
  });

  it("passes initialization options through", () => {
    atom.config.set("pulsar-ide-julia.initializationOptionsJson", '{"n_analysis_workers": 2}');
    expect(client.getInitializeParams(fixtures, { pid: 1 }).initializationOptions).toEqual({ n_analysis_workers: 2 });
  });
});
