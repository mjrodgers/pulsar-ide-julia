const { splitArgs, buildAdapterCommand, buildLaunchArguments, adapterContext, BOOTSTRAP } = require("../lib/debug/launch");
const { BreakpointStore } = require("../lib/debug/store");
const { OutputLog } = require("../lib/debug/log");
const { currentLocation } = require("../lib/debug/location");

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

describe("BreakpointStore", () => {
  it("toggles, lists in line order and reports changes", () => {
    const s = new BreakpointStore();
    const changes = [];
    s.onDidChange((f) => changes.push(f));
    expect(s.toggle("/a.jl", 9)).toBe(true);
    s.toggle("/a.jl", 3);
    expect(s.list("/a.jl").map((b) => b.line)).toEqual([3, 9]);
    expect(s.toggle("/a.jl", 9)).toBe(false);
    expect(s.has("/a.jl", 9)).toBe(false);
    expect(changes).toEqual(["/a.jl", "/a.jl", "/a.jl"]);
  });
  it("only includes files that have breakpoints in all()", () => {
    const s = new BreakpointStore();
    s.toggle("/a.jl", 1);
    s.toggle("/b.jl", 2);
    s.toggle("/b.jl", 2);
    expect([...s.all().keys()]).toEqual(["/a.jl"]);
  });
  it("keeps conditions, moves lines, and merges when two meet", () => {
    const s = new BreakpointStore();
    s.toggle("/a.jl", 3);
    s.setCondition("/a.jl", 3, "x > 1");
    s.moveLine("/a.jl", 3, 5);
    expect(s.list("/a.jl")).toEqual([{ line: 5, condition: "x > 1" }]);
    s.toggle("/a.jl", 6);
    s.moveLine("/a.jl", 6, 5);
    expect(s.list("/a.jl")).toEqual([{ line: 5, condition: "x > 1" }]);
    expect(s.setCondition("/a.jl", 99, "y")).toBe(false);
  });
  it("clears one file or everything", () => {
    const s = new BreakpointStore();
    s.toggle("/a.jl", 1);
    s.toggle("/b.jl", 1);
    s.clear("/a.jl");
    expect(s.files()).toEqual(["/b.jl"]);
    s.clear();
    expect(s.files()).toEqual([]);
  });
});

describe("OutputLog", () => {
  it("collects text and notifies", () => {
    const log = new OutputLog();
    const seen = [];
    log.onDidAppend((c) => seen.push(c));
    log.append("hello\n");
    log.note("done");
    expect(log.text()).toBe("hello\ndone\n");
    expect(seen.map((c) => c.category)).toEqual(["stdout", "note"]);
    log.append("");
    expect(seen.length).toBe(2);
  });
  it("drops the oldest output past its limit", () => {
    const log = new OutputLog();
    log.append("a".repeat(300000));
    log.append("b".repeat(300000));
    expect(log.text().startsWith("b")).toBe(true);
  });
  it("can be cleared", () => {
    const log = new OutputLog();
    log.append("x");
    log.clear();
    expect(log.text()).toBe("");
  });
});

describe("currentLocation", () => {
  const frames = [{ id: 1, name: "inner", file: "/a.jl", line: 3 }, { id: 2, name: "outer", file: "/a.jl", line: 20 }];
  it("is the selected frame while stopped", () => {
    expect(currentLocation({ status: "stopped", frames, frameId: 2 })).toEqual({ file: "/a.jl", line: 20, frameId: 2 });
    expect(currentLocation({ status: "stopped", frames, frameId: undefined }).line).toBe(3);
  });
  it("is nothing otherwise, or when the frame has no usable source", () => {
    expect(currentLocation(null)).toBe(null);
    expect(currentLocation({ status: "running", frames, frameId: 1 })).toBe(null);
    expect(currentLocation({ status: "stopped", frames: [{ id: 1, name: "f", line: 3 }], frameId: 1 })).toBe(null);
    expect(currentLocation({ status: "stopped", frames: [], frameId: 1 })).toBe(null);
  });
});
