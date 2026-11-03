// What pulsar-ide-julia gives pulsar-ide-debugger through `debug-adapter` 0.2.0: the configuration for Debug File
// and how to start the adapter, built from this package's settings. (The debugger itself, and its specs, are in
// pulsar-ide-debugger.)
const { EventEmitter } = require("events");
const { createDebugAdapterProvider } = require("../lib/debug/provider");
const { explainLaunchFailure } = require("../lib/debug/adapter-process");

const defaults = {
  "debugger.juliaPath": "", "debugger.threads": "", "debugger.environment": "", "debugger.flags": "",
  "debugger.stopOnEntry": false, "debugger.launchArgumentsJson": "", "debugger.exceptionFilters": ["error"],
  "debugger.programArguments": "", "debugger.compiledMode": false, "debugger.compiledModules": [],
};

describe("Julia debug adapter provider", () => {
  let settings, provider, launches, waited;

  const make = (overrides = {}) => {
    settings = { ...defaults, ...overrides };
    launches = [];
    waited = 0;
    provider = createDebugAdapterProvider({
      setting: (k) => settings[k],
      shellEnvironment: async () => { waited++; return true; },
      launch: async (options) => {
        launches.push(options);
        return { socket: "the socket", child: Object.assign(new EventEmitter(), { kill() {} }) };
      },
      env: { PATH: "/from/shell" },
    });
  };

  // What Debug File sends, without the type, request and name every configuration has.
  const launchArguments = (file) => {
    const { configuration, warning } = provider.configurationForFile({ file });
    const { type, request, name, ...args } = configuration;
    return { type, request, name, args, warning };
  };

  it("describes itself to the debugger", () => {
    make();
    expect(provider.name).toBe("Julia");
    expect(provider.types).toEqual(["julia"]);
    expect(provider.grammarScopes).toEqual(["source.julia"]);
  });

  it("waits for the shell's PATH, then starts Julia with the debugger settings, next to the program", async () => {
    make({ "debugger.juliaPath": "/opt/julia/bin/julia", "debugger.threads": "4", "debugger.environment": "@v1.12", "debugger.flags": "--color=no" });
    const log = { append() {}, note() {} };
    const result = await provider.createAdapter({ type: "julia", request: "launch", program: "/work/a.jl" }, { log, projectPath: "/work" });
    expect(waited).toBe(1);
    expect(launches[0].file).toBe("/work/a.jl");
    expect(launches[0].log).toBe(log);
    expect(launches[0].env).toEqual({ PATH: "/from/shell" });
    expect(launches[0].settings).toEqual({ juliaPath: "/opt/julia/bin/julia", threads: "4", environment: "@v1.12", flags: "--color=no" });
    expect(result.stream).toBe("the socket");
    expect(typeof result.process.kill).toBe("function");
  });

  it("starts the adapter in the project folder for a configuration without a program", async () => {
    make();
    await provider.createAdapter({ type: "julia", request: "launch", code: "1 + 1" }, { log: null, projectPath: "/work" });
    expect(launches[0].file).toBe("/work/main.jl");
  });

  it("sends the program and stopOnEntry by default", () => {
    make({ "debugger.stopOnEntry": true });
    expect(launchArguments("/work/a.jl")).toEqual({
      type: "julia", request: "launch", name: "Debug a.jl", args: { program: "/work/a.jl", stopOnEntry: true }, warning: undefined,
    });
  });

  it("sends program arguments and compiled mode from the settings", () => {
    make({ "debugger.programArguments": "--n 3", "debugger.compiledMode": true, "debugger.compiledModules": ["Base"] });
    expect(launchArguments("/work/a.jl").args).toEqual({
      program: "/work/a.jl", stopOnEntry: false, args: ["--n", "3"], compiledMode: true, compiledModulesOrFunctions: ["Base"],
    });
  });

  it("merges launch arguments from the settings and warns about bad JSON", () => {
    make({ "debugger.launchArgumentsJson": '{"args":["--n","3"]}' });
    expect(launchArguments("/work/a.jl").args).toEqual({ program: "/work/a.jl", stopOnEntry: false, args: ["--n", "3"] });
    make({ "debugger.launchArgumentsJson": "{oops" });
    expect(launchArguments("/work/a.jl").warning).toMatch(/not valid JSON/);
  });

  it("passes on the exception filters setting", () => {
    make();
    expect(provider.defaultExceptionFilters()).toEqual(["error"]);
    make({ "debugger.exceptionFilters": undefined });
    expect(provider.defaultExceptionFilters()).toEqual([]);
  });

  it("explains launch failures with the configured Julia path", () => {
    make({ "debugger.juliaPath": "/opt/julia" });
    expect(provider.explainFailure({ code: "ENOENT", message: "x" })).toMatch(/`\/opt\/julia`/);
  });
});

describe("explainLaunchFailure", () => {
  it("recognises a missing julia executable", () => {
    expect(explainLaunchFailure({ code: "ENOENT", message: "x" }, { juliaPath: "/opt/julia" })).toMatch(/`\/opt\/julia`/);
  });
  it("recognises a missing DebugAdapter package", () => {
    const e = { message: "exited", stderrTail: "ERROR: ArgumentError: Package DebugAdapter not found in current path." };
    expect(explainLaunchFailure(e)).toMatch(/Pkg.add\("DebugAdapter"\)/);
  });
  it("falls back to the error message", () => {
    expect(explainLaunchFailure({ message: "boom", stderrTail: "" })).toBe("boom");
  });
});
