// Activates the package against a fake server (no Julia needed). Jasmine 2 style.
// The spies are installed BEFORE activation (see helpers/activate.js), so no real
// `jetls` can be started, even for an editor left open by an earlier spec.
//
// NOTE: Jasmine 2's `callFake` rejects `async` functions (their type tag is not
// "Function"), so fakes below are plain functions that return promises.
const path = require("path");
const { activateJulia, trace } = require("./helpers/activate");
const { deferred } = require("./helpers/deferred");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("activation", () => {
  let client, started, configAnswered;

  useTimeout(SLOW);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    started = deferred();
    configAnswered = deferred();

    client = await activateJulia({
      prepare: (c) => {
        spyOn(c, "startServerProcess").and.callFake((projectPath) => {
          trace(`startServerProcess(${projectPath})`);
          started.resolve(projectPath);
          return c.spawnChildNode([fakeServer], { cwd: projectPath });
        });

        // The fork registers `this.getWorkspaceConfiguration.bind(this)` when a server
        // starts, so a spy installed beforehand sees the fake server's request.
        const original = c.getWorkspaceConfiguration.bind(c);
        spyOn(c, "getWorkspaceConfiguration").and.callFake((params) => {
          trace(`server asked for configuration: ${JSON.stringify(params)}`);
          return original(params).then((result) => {
            trace(`answered with: ${JSON.stringify(result)}`);
            configAnswered.resolve({ params, result });
            return result;
          });
        });
      },
    });
  }));

  it("registers the restart command", () => {
    const names = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) }).map((c) => c.name);
    expect(names).toContain("pulsar-ide-julia:restart-language-server");
  });

  it("starts a server for the project when a .jl file opens", reportErrors(async () => {
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    // The fork hands over the root with a trailing separator; compare resolved paths.
    expect(path.resolve(await started.promise)).toBe(path.resolve(fixtures));
  }));

  it("answers the server's workspace/configuration request from Pulsar settings", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
    atom.config.set("pulsar-ide-julia.debounce", 2.5);

    trace("opening hello.jl; waiting for the fake server to ask for configuration");
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    const { params, result } = await configAnswered.promise;

    expect(params.items[0].section).toBe("jetls");
    expect(result).toEqual([{ full_analysis: { debounce: 2.5 }, formatter: "JuliaFormatter" }]);
  }));

  it("resolves workspace/configuration sections from Pulsar settings", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.formatter", "JuliaFormatter");
    const result = await client.getWorkspaceConfiguration({
      items: [{ section: "jetls" }, { section: "jetls.formatter" }, { section: "other" }],
    });
    expect(result[0]).toEqual({ formatter: "JuliaFormatter" });
    expect(result[1]).toBe("JuliaFormatter");
    expect(result[2]).toBeUndefined();
  }));

  it("advertises workspace.configuration support", () => {
    const params = client.getInitializeParams(fixtures, { pid: 1 });
    expect(params.capabilities.workspace.configuration).toBe(true);
  });

  it("reports Pulsar (the client), not the server, as the process id", () => {
    expect(client.getInitializeParams(fixtures, { pid: 1 }).processId).toBe(process.pid);
  });

  it("passes initialization options through", () => {
    atom.config.set("pulsar-ide-julia.initializationOptionsJson", '{"n_analysis_workers": 2}');
    expect(client.getInitializeParams(fixtures, { pid: 1 }).initializationOptions).toEqual({ n_analysis_workers: 2 });
  });
});
