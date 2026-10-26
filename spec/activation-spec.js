// Activates the package against a fake server (no Julia needed). Jasmine 2 style.
// `startServerProcess` is stubbed AFTER activation and BEFORE a file is opened.
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { deferred } = require("./helpers/deferred");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("activation", () => {
  let client;

  const useFakeServer = () =>
    spyOn(client, "startServerProcess").and.callFake((projectPath) =>
      client.spawnChildNode([fakeServer], { cwd: projectPath }));

  beforeEach(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia();
  }, SLOW);

  it("registers the restart command", () => {
    const names = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) }).map((c) => c.name);
    expect(names).toContain("pulsar-ide-julia:restart-language-server");
  });

  it("starts a server for the project when a .jl file opens", async () => {
    const started = deferred();
    spyOn(client, "startServerProcess").and.callFake((projectPath) => {
      started.resolve(projectPath);
      return client.spawnChildNode([fakeServer], { cwd: projectPath });
    });
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    expect(await started.promise).toBe(fixtures);
  }, SLOW);

  it("answers the server's workspace/configuration request from Pulsar settings", async () => {
    atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
    atom.config.set("pulsar-ide-julia.debounce", 2.5);

    // The fork registers `this.getWorkspaceConfiguration.bind(this)` when a server
    // starts, so a spy installed beforehand sees the fake server's request.
    const answered = deferred();
    const original = client.getWorkspaceConfiguration.bind(client);
    spyOn(client, "getWorkspaceConfiguration").and.callFake(async (params) => {
      const result = await original(params);
      answered.resolve({ params, result });
      return result;
    });
    useFakeServer();

    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    const { params, result } = await answered.promise;
    expect(params.items[0].section).toBe("jetls");
    expect(result).toEqual([{ full_analysis: { debounce: 2.5 }, formatter: "JuliaFormatter" }]);
  }, SLOW);

  it("resolves workspace/configuration sections from Pulsar settings", async () => {
    atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
    const result = await client.getWorkspaceConfiguration({
      items: [{ section: "jetls" }, { section: "jetls.formatter" }, { section: "other" }],
    });
    expect(result[0]).toEqual({ formatter: "JuliaFormatter" });
    expect(result[1]).toBe("JuliaFormatter");
    expect(result[2]).toBeUndefined();
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
