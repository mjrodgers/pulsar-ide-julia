// Installing DebugAdapter.jl into its own environment (lib/debug/install.js).
const { EventEmitter } = require("events");
const { runInstall, installCommand, projectArgument, INSTALL_CODE } = require("../lib/debug/install");
const { explainLaunchFailure } = require("../lib/debug/adapter-process");

// A child process that prints `output` and exits with `code`.
const fakeSpawn = (calls, { code = 0, output = "", error = null } = {}) => (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (error) return child.emit("error", error);
    child.stderr.emit("data", output);
    return child.emit("close", code);
  });
  return child;
};

describe("installing DebugAdapter.jl", () => {
  it("uses its own shared environment by default, or the one set", () => {
    expect(projectArgument("")).toBe("@pulsar-debugadapter");
    expect(projectArgument(undefined)).toBe("@pulsar-debugadapter");
    expect(projectArgument("@dap")).toBe("@dap");
    expect(projectArgument("~/envs/dap", "/home/u")).toBe("/home/u/envs/dap");
    expect(installCommand("")).toBe(`julia --project=@pulsar-debugadapter -e '${INSTALL_CODE}'`);
  });

  it("adds, updates and precompiles it with the debugger's Julia", async () => {
    const calls = [];
    const result = await runInstall({ juliaPath: "~/bin/julia", environment: "", homedir: "/home/u", env: { PATH: "/x" }, spawn: fakeSpawn(calls, { output: "Precompiling…\n" }) });
    expect(result).toEqual({ ok: true, output: "Precompiling…\n" });
    expect(calls[0].command).toBe("/home/u/bin/julia");
    expect(calls[0].args).toEqual(["--project=@pulsar-debugadapter", "-e", INSTALL_CODE]);
    expect(calls[0].options.env).toEqual({ PATH: "/x" });
    expect(INSTALL_CODE).toContain('Pkg.add("DebugAdapter")');
    expect(INSTALL_CODE).toContain("Pkg.update()");
  });

  it("reports a failure with what Julia printed, or a missing julia", async () => {
    const failed = await runInstall({ spawn: fakeSpawn([], { code: 1, output: "ERROR: Unsatisfiable requirements" }) });
    expect(failed).toEqual({ ok: false, output: "ERROR: Unsatisfiable requirements" });
    const missing = await runInstall({ spawn: fakeSpawn([], { error: Object.assign(new Error("spawn julia ENOENT"), { code: "ENOENT" }) }) });
    expect(missing).toEqual({ ok: false, output: "Could not run `julia`." });
  });

  it("points to the install command when the debugger cannot load DebugAdapter", () => {
    const e = { message: "exited", stderrTail: "ERROR: ArgumentError: Package DebugAdapter not found in current path." };
    const text = explainLaunchFailure(e, { adapterEnvironment: "@dap" });
    expect(text).toMatch(/Install Debug Adapter/);
    expect(text).toContain("julia --project=@dap -e");
  });
});
