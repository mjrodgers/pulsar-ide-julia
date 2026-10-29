// Moving settings saved under the old, ungrouped names.
const { MOVED, migrateSettings } = require("../lib/config-keys");

// atom.config's get/set/unset over a flat map of key paths.
const fakeConfig = (initial) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (k) => values.get(k),
    set: (k, v) => { values.set(k, v); },
    unset: (k) => { values.delete(k); },
  };
};

describe("migrateSettings", () => {
  it("moves values set under old names into their groups and removes the old names", () => {
    const config = fakeConfig({
      "pulsar-ide-julia.replThreads": "4",
      "pulsar-ide-julia.formatter": "JuliaFormatter",
      "pulsar-ide-julia.debugExceptionFilters": [],
      "pulsar-ide-julia.outlineLocals": false,
      "other-package.replThreads": "x",
    });
    const moved = migrateSettings(config, "pulsar-ide-julia");
    expect(moved.sort()).toEqual(["debugExceptionFilters", "formatter", "outlineLocals", "replThreads"]);
    expect(Object.fromEntries(config.values)).toEqual({
      "pulsar-ide-julia.repl.threads": "4",
      "pulsar-ide-julia.server.formatter": "JuliaFormatter",
      "pulsar-ide-julia.debugger.exceptionFilters": [],   // an empty list is a real choice: kept
      "pulsar-ide-julia.outline.locals": false,
      "other-package.replThreads": "x",
    });
  });

  it("does nothing the second time", () => {
    const config = fakeConfig({ "pulsar-ide-julia.workspaceModule": "Main.Oscar" });
    migrateSettings(config, "pulsar-ide-julia");
    const after = new Map(config.values);
    expect(migrateSettings(config, "pulsar-ide-julia")).toEqual([]);
    expect(config.values).toEqual(after);
    expect(config.get("pulsar-ide-julia.repl.workspaceModule")).toBe("Main.Oscar");
  });

  it("places every old setting in one of the four groups, each name once", () => {
    const targets = Object.values(MOVED);
    expect(new Set(targets).size).toBe(targets.length);
    for (const t of targets) expect(t).toMatch(/^(server|outline|repl|debugger)\.\w+$/);
  });
});

describe("settings that moved to pulsar-ide-debugger", () => {
  it("moves the pane settings, under their old and their grouped names", () => {
    const config = fakeConfig({
      "pulsar-ide-julia.debugOpenWorkspace": false,
      "pulsar-ide-julia.debugger.openOutput": false,
      "pulsar-ide-julia.debugger.stopOnEntry": true,
    });
    const moved = migrateSettings(config, "pulsar-ide-julia");
    expect(moved.sort()).toEqual(["debugOpenWorkspace", "debugger.openOutput"]);
    expect(Object.fromEntries(config.values)).toEqual({
      "pulsar-ide-debugger.openWorkspace": false,
      "pulsar-ide-debugger.openOutput": false,
      "pulsar-ide-julia.debugger.stopOnEntry": true,
    });
  });

  it("only moves into pulsar-ide-debugger", () => {
    const { MOVED_OUT } = require("../lib/config-keys");
    for (const t of Object.values(MOVED_OUT)) expect(t).toMatch(/^pulsar-ide-debugger\.\w+$/);
  });
});
