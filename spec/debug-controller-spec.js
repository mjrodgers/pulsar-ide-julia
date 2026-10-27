const { EventEmitter } = require("events");
const { startFakeAdapter } = require("./helpers/fake-adapter");
const { DebugController } = require("../lib/debug/controller");
const { explainLaunchFailure } = require("../lib/debug/adapter-process");

const until = async (predicate, what = "condition", ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

const fakeEditor = (file, { row = 4, modified = false } = {}) => ({
  saved: 0,
  getPath: () => file,
  isModified: () => modified,
  save() { this.saved++; return Promise.resolve(); },
  getCursorBufferPosition: () => ({ row }),
});

describe("DebugController (against a fake adapter)", () => {
  let server, controller, ui, notes, settings, children, launches;

  const makeController = (options = {}) => {
    settings = {
      debugStopOnEntry: true, debugLaunchArgumentsJson: "", debugJuliaPath: "", debugThreads: "", debugEnvironment: "", debugFlags: "",
      debugOpenWorkspace: true, debugOpenOutput: true, debugExceptionFilters: [], debugProgramArguments: "", debugCompiledMode: false, debugCompiledModules: [], ...options.settings,
    };
    ui = { locations: [], workspace: 0, output: 0, showLocation(l) { this.locations.push(l); }, openWorkspace() { this.workspace++; }, openOutput() { this.output++; } };
    notes = [];
    children = [];
    launches = [];
    controller = new DebugController({
      setting: (k) => settings[k],
      notifications: ["addInfo", "addWarning", "addError"].reduce((o, k) => ({ ...o, [k]: (message, opts) => notes.push([k, message, opts]) }), {}),
      ui,
      getActiveEditor: () => options.editor || null,
      launch: options.launch || (async (args) => {
        launches.push(args);
        const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });
        children.push(child);
        return { socket: await server.connect(), child };
      }),
    });
  };

  const settled = () => controller.session && controller.session.state.status === "stopped" && !controller.session.state.loading && controller.session.state.contexts.length > 0;

  afterEach(async () => {
    if (controller) await controller.destroy();
    if (server) await server.close();
    controller = server = undefined;
  });

  it("debugs the file in the editor: launches, stops on entry, shows the location and variables", async () => {
    server = await startFakeAdapter();
    makeController();
    const editor = fakeEditor("/work/a.jl", { modified: true });
    expect(await controller.debugFile(editor)).toBe(true);
    await until(settled, "stop on entry");
    expect(editor.saved).toBe(1);
    expect(launches[0].file).toBe("/work/a.jl");
    expect(server.adapter.launchRequest.arguments).toEqual({ program: "/work/a.jl", stopOnEntry: true });
    expect(controller.model.statusText()).toBe("Stopped (entry) in inner at a.jl:3");
    expect(ui.locations[ui.locations.length - 1]).toEqual({ file: "/work/a.jl", line: 3, frameId: 100 });
    expect(controller.model.rows().find((r) => r.name === "x").value).toBe("0");
    expect(ui.workspace).toBe(1);
  });

  it("sends the existing breakpoints with the launch and updates them while stopped", async () => {
    server = await startFakeAdapter();
    makeController({ settings: { debugStopOnEntry: false } });
    controller.store.toggle("/work/a.jl", 12);
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled, "stop at breakpoint");
    expect(server.adapter.breakpoints.get("/work/a.jl")).toEqual([{ line: 12 }]);
    expect(controller.model.statusText()).toBe("Stopped (breakpoint) in inner at a.jl:12");

    controller.store.toggle("/work/a.jl", 30);
    await until(() => (server.adapter.breakpoints.get("/work/a.jl") || []).length === 2, "pushed breakpoint");
    controller.clearBreakpoints();
    await until(() => server.adapter.breakpoints.get("/work/a.jl").length === 0, "cleared breakpoints");
  });

  it("steps and continues, and cleans up when the program finishes", async () => {
    server = await startFakeAdapter();
    makeController();
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    await controller.step("stepOver");
    await until(() => settled() && controller.session.state.frames[0].line === 4, "after step");
    expect(ui.locations.some((l) => l === null)).toBe(true); // cleared while running
    expect(ui.locations[ui.locations.length - 1].line).toBe(4);
    await controller.step("continue");
    await until(() => !controller.active, "program end");
    expect(ui.locations[ui.locations.length - 1]).toBe(null);
    expect(controller.log.text()).toMatch(/Debug session ended/);
  });

  it("stops the session on request and kills the Julia process", async () => {
    server = await startFakeAdapter();
    makeController();
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    await controller.stop();
    expect(controller.active).toBe(false);
    await until(() => children[0].killed, "child killed", 4000);
  });

  it("tells the user instead of stepping when there is nothing to step", async () => {
    server = await startFakeAdapter();
    makeController();
    await controller.step("stepOver");
    expect(notes[0][0]).toBe("addInfo");
    expect(notes[0][1]).toMatch(/no debug session/);
    await controller.debugFile(fakeEditor("/work/a.jl"), {});
    await until(settled);
    await controller.step("continue");
    await until(() => !controller.active);
  });

  it("refuses a second session while one is active", async () => {
    server = await startFakeAdapter();
    makeController();
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    expect(await controller.debugFile(fakeEditor("/work/b.jl"))).toBe(false);
    expect(notes.pop()[1]).toMatch(/already running/);
    expect(launches.length).toBe(1);
  });

  it("start-or-continue starts when idle and continues when stopped", async () => {
    server = await startFakeAdapter();
    makeController({ editor: fakeEditor("/work/a.jl") });
    await controller.commandTable()["debug-start-or-continue"]();
    await until(settled);
    await controller.commandTable()["debug-start-or-continue"]();
    await until(() => !controller.active, "continued to the end");
  });

  it("needs a saved file", async () => {
    server = await startFakeAdapter();
    makeController();
    expect(await controller.debugFile(fakeEditor(undefined))).toBe(false);
    expect(await controller.debugFile(null)).toBe(false);
    expect(notes.every(([kind]) => kind === "addWarning")).toBe(true);
    expect(launches.length).toBe(0);
  });

  it("reports an adapter that cannot be started, with an explanation", async () => {
    makeController({ launch: async () => { const e = new Error("spawn julia ENOENT"); e.code = "ENOENT"; throw e; } });
    expect(await controller.debugFile(fakeEditor("/work/a.jl"))).toBe(false);
    expect(notes[0][0]).toBe("addError");
    expect(notes[0][1]).toMatch(/Could not run `julia`/);
    expect(controller.active).toBe(false);
    // and it can try again afterwards
    expect(controller.starting).toBe(false);
  });

  it("reports a refused launch and shuts the session down", async () => {
    server = await startFakeAdapter({ failLaunch: "program not found" });
    makeController();
    expect(await controller.debugFile(fakeEditor("/work/a.jl"))).toBe(false);
    expect(notes.some(([kind, msg]) => kind === "addError" && /program not found/.test(msg))).toBe(true);
    await until(() => !controller.active, "session closed");
    expect(children[0].killed).toBe(true);
  });

  it("sends program arguments and compiled mode from the settings", async () => {
    server = await startFakeAdapter();
    makeController({ settings: { debugProgramArguments: "--n 3", debugCompiledMode: true, debugCompiledModules: ["Base"] } });
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    expect(server.adapter.launchRequest.arguments).toEqual({
      program: "/work/a.jl", stopOnEntry: true, args: ["--n", "3"], compiledMode: true, compiledModulesOrFunctions: ["Base"],
    });
  });

  it("merges launch arguments from the settings and warns about bad JSON", async () => {
    server = await startFakeAdapter();
    makeController({ settings: { debugStopOnEntry: false, debugLaunchArgumentsJson: '{"args":["--n","3"]}' } });
    controller.store.toggle("/work/a.jl", 5);
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    expect(server.adapter.launchRequest.arguments).toEqual({ program: "/work/a.jl", stopOnEntry: false, args: ["--n", "3"] });
    await controller.stop();

    makeController({ settings: { debugLaunchArgumentsJson: "{oops" } });
    await controller.debugFile(fakeEditor("/work/a.jl"));
    expect(notes.some(([kind, msg]) => kind === "addWarning" && /not valid JSON/.test(msg))).toBe(true);
  });

  it("routes program output to the log and opens the output pane once", async () => {
    server = await startFakeAdapter();
    makeController();
    await controller.debugFile(fakeEditor("/work/a.jl"));
    await until(settled);
    controller.session.emit("output", { category: "stdout", text: "hello\n" });
    controller.session.emit("output", { category: "stderr", text: "warn\n" });
    controller.session.emit("output", { category: "telemetry", text: "ignored" });
    expect(controller.log.text()).toContain("hello\nwarn\n");
    expect(controller.log.text()).not.toContain("ignored");
    expect(ui.output).toBe(1);
  });

  it("toggles a breakpoint on the cursor line", () => {
    makeController();
    controller.toggleBreakpoint(fakeEditor("/work/a.jl", { row: 6 }));
    expect(controller.store.list("/work/a.jl")).toEqual([{ line: 7, condition: "" }]);
    controller.toggleBreakpoint(fakeEditor("/work/a.jl", { row: 6 }));
    expect(controller.store.list("/work/a.jl")).toEqual([]);
    controller.toggleBreakpoint(fakeEditor(undefined));
    expect(notes[0][0]).toBe("addWarning");
  });

  it("exposes every command", () => {
    makeController();
    expect(Object.keys(controller.commandTable()).sort()).toEqual([
      "clear-breakpoints", "debug-continue", "debug-file", "debug-start-or-continue", "debug-step-in", "debug-step-out",
      "debug-step-over", "debug-stop", "open-workspace", "show-debug-output", "toggle-breakpoint",
    ]);
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
