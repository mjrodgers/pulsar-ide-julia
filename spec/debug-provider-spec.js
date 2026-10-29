// What pulsar-ide-julia gives pulsar-ide-debugger: the adapter launch and the `launch` request, built from this
// package's settings. (The debugger itself, and its specs, are in pulsar-ide-debugger.)
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

  it("describes itself to the debugger", () => {
    make();
    expect(provider.name).toBe("Julia");
    expect(provider.grammarScopes).toEqual(["source.julia"]);
    expect(provider.adapterID).toBe("julia");
  });

  it("waits for the shell's PATH, then starts Julia with the debugger settings", async () => {
    make({ "debugger.juliaPath": "/opt/julia/bin/julia", "debugger.threads": "4", "debugger.environment": "@v1.12", "debugger.flags": "--color=no" });
    const log = { append() {}, note() {} };
    const result = await provider.launch({ file: "/work/a.jl", log });
    expect(waited).toBe(1);
    expect(launches[0].file).toBe("/work/a.jl");
    expect(launches[0].log).toBe(log);
    expect(launches[0].env).toEqual({ PATH: "/from/shell" });
    expect(launches[0].settings).toEqual({ juliaPath: "/opt/julia/bin/julia", threads: "4", environment: "@v1.12", flags: "--color=no" });
    expect(result.stream).toBe("the socket");
  });

  it("sends the program and stopOnEntry by default", () => {
    make({ "debugger.stopOnEntry": true });
    expect(provider.launchRequest({ file: "/work/a.jl" })).toEqual({ request: "launch", args: { program: "/work/a.jl", stopOnEntry: true }, warning: undefined });
  });

  it("sends program arguments and compiled mode from the settings", () => {
    make({ "debugger.programArguments": "--n 3", "debugger.compiledMode": true, "debugger.compiledModules": ["Base"] });
    expect(provider.launchRequest({ file: "/work/a.jl" }).args).toEqual({
      program: "/work/a.jl", stopOnEntry: false, args: ["--n", "3"], compiledMode: true, compiledModulesOrFunctions: ["Base"],
    });
  });

  it("merges launch arguments from the settings and warns about bad JSON", () => {
    make({ "debugger.launchArgumentsJson": '{"args":["--n","3"]}' });
    expect(provider.launchRequest({ file: "/work/a.jl" }).args).toEqual({ program: "/work/a.jl", stopOnEntry: false, args: ["--n", "3"] });
    make({ "debugger.launchArgumentsJson": "{oops" });
    expect(provider.launchRequest({ file: "/work/a.jl" }).warning).toMatch(/not valid JSON/);
  });

  it("passes on the exception filters setting", () => {
    make();
    expect(provider.exceptionFilters()).toEqual(["error"]);
    make({ "debugger.exceptionFilters": undefined });
    expect(provider.exceptionFilters()).toEqual([]);
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
