const { splitArgs, buildAdapterCommand, buildLaunchArguments, adapterContext, BOOTSTRAP } = require("../lib/debug/launch");

describe("splitArgs", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("--color=yes  -O3")).toEqual(["--color=yes", "-O3"]);
    expect(splitArgs(`-e "using Revise; x = 1" --check-bounds=yes`)).toEqual(["-e", "using Revise; x = 1", "--check-bounds=yes"]);
    expect(splitArgs(`-e 'println("a b")'`)).toEqual(["-e", 'println("a b")']);
    expect(splitArgs(`a\\ b "c\\"d"`)).toEqual(["a b", 'c"d']);
    expect(splitArgs(`"" x`)).toEqual(["", "x"]);
  });
});

describe("buildAdapterCommand", () => {
  const pipe = "/tmp/p.sock";
  it("runs the bootstrap in the file's project", () => {
    const { command, args } = buildAdapterCommand({ projectDir: "/work/Pkg", pipe });
    expect(command).toBe("julia");
    expect(args).toEqual(["--project=/work/Pkg", "-e", BOOTSTRAP, pipe]);
  });
  it("omits --project when there is none", () => {
    expect(buildAdapterCommand({ pipe }).args).toEqual(["-e", BOOTSTRAP, pipe]);
  });
  it("lets the setting override the project, threads, flags and Julia path", () => {
    const { command, args } = buildAdapterCommand({
      juliaPath: "~/bin/julia", threads: "auto", environment: "@v1.12", projectDir: "/work/Pkg", flags: "--color=yes -O1", pipe, homedir: "/home/u",
    });
    expect(command).toBe("/home/u/bin/julia");
    expect(args).toEqual(["--threads=auto", "--project=@v1.12", "--color=yes", "-O1", "-e", BOOTSTRAP, pipe]);
  });
  it("loads the adapter from the default environment", () => {
    expect(BOOTSTRAP).toContain("import DebugAdapter");
    expect(BOOTSTRAP).toContain("DebugSession(conn)");
    expect(BOOTSTRAP).toContain("ARGS[1]");
  });
});

describe("buildLaunchArguments", () => {
  it("sends the program and stopOnEntry by default", () => {
    expect(buildLaunchArguments({ file: "/work/a.jl" })).toEqual({ args: { program: "/work/a.jl", stopOnEntry: false }, error: null });
    expect(buildLaunchArguments({ file: "/work/a.jl", stopOnEntry: true }).args.stopOnEntry).toBe(true);
  });
  it("adds the optional fields only when they are set", () => {
    const { args } = buildLaunchArguments({ file: "/a.jl", programArgs: '--n 3 "a b"', compiledMode: true, compiledModules: ["Base", " LinearAlgebra ", ""] });
    expect(args).toEqual({ program: "/a.jl", stopOnEntry: false, args: ["--n", "3", "a b"], compiledMode: true, compiledModulesOrFunctions: ["Base", "LinearAlgebra"] });
    expect(Object.keys(buildLaunchArguments({ file: "/a.jl", compiledModules: [] }).args)).toEqual(["program", "stopOnEntry"]);
  });
  it("lets extra JSON override the settings", () => {
    expect(buildLaunchArguments({ file: "/a.jl", programArgs: "x", extraJson: '{"args":["y"],"cwd":"/tmp"}' }).args)
      .toEqual({ program: "/a.jl", stopOnEntry: false, args: ["y"], cwd: "/tmp" });
  });
  it("merges extra JSON and removes fields set to null", () => {
    const { args } = buildLaunchArguments({ file: "/a.jl", extraJson: '{"args":["x"],"stopOnEntry":null,"compiledMode":true}' });
    expect(args).toEqual({ program: "/a.jl", args: ["x"], compiledMode: true });
  });
  it("reports bad JSON but still returns the defaults", () => {
    const r = buildLaunchArguments({ file: "/a.jl", extraJson: "{nope" });
    expect(r.error).toMatch(/not valid JSON/);
    expect(r.args.program).toBe("/a.jl");
  });
});

describe("adapterContext", () => {
  it("finds the project above the file", () => {
    const exists = (p) => p === "/work/Pkg/Project.toml";
    expect(adapterContext("/work/Pkg/src/a.jl", { exists })).toEqual({ cwd: "/work/Pkg/src", projectDir: "/work/Pkg" });
    expect(adapterContext("/elsewhere/a.jl", { exists }).projectDir).toBe(null);
  });
});
