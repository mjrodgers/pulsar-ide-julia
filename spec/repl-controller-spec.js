// ReplController with fakes for the editor, workspace and terminal service (no Pulsar needed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ReplController } = require("../lib/repl");

function fakeEditor({ text, filePath = null, cursor = [0, 0], selection = null, modified = false }) {
  const lines = text.split("\n");
  const rangeOf = (r) => (Array.isArray(r) ? { start: { row: r[0][0], column: r[0][1] }, end: { row: r[1][0], column: r[1][1] } } : r);
  const ed = {
    saved: false,
    selections: [selection || [[cursor[0], cursor[1]], [cursor[0], cursor[1]]]],
    cursor: { row: cursor[0], column: cursor[1] },
    getPath: () => filePath,
    getText: () => text,
    isModified: () => modified,
    save: async () => { ed.saved = true; modified = false; },
    getBuffer: () => ({ getLines: () => lines }),
    lineTextForBufferRow: (r) => lines[r],
    getCursorBufferPosition: () => ed.cursor,
    setCursorBufferPosition: (p) => { ed.cursor = { row: p[0], column: p[1] }; },
    getSelectedBufferRange: () => {
      const r = rangeOf(ed.selections[0]);
      return { ...r, isEmpty: () => r.start.row === r.end.row && r.start.column === r.end.column };
    },
    getSelectedBufferRanges: () => ed.selections.slice(),
    setSelectedBufferRange: (r) => { ed.selections = [r]; },
    setSelectedBufferRanges: (rs) => { ed.selections = rs; },
    getTextInBufferRange: (r) => {
      const { start, end } = rangeOf(r);
      if (start.row === end.row) return lines[start.row].slice(start.column, end.column);
      return [lines[start.row].slice(start.column), ...lines.slice(start.row + 1, end.row), lines[end.row].slice(0, end.column)].join("\n");
    },
    markBufferRange: () => ({ destroy() {} }),
    decorateMarker: () => {},
  };
  return ed;
}

function setup({ editor, settings = {}, symbols = null, symbolsError = null, bridge = undefined, deps = {} } = {}) {
  const log = { open: 0, runs: [], notes: [], dispatched: [] };
  const service = { open: async () => { log.open++; }, run: async (cmds) => { log.runs.push(cmds); return true; } };
  const notifications = new Proxy({}, { get: (_, kind) => (msg) => log.notes.push([kind, msg]) });
  const values = { "repl.juliaPath": "", "repl.threads": "", "repl.environment": "", "repl.flags": "", "repl.sendVia": "service", "repl.bracketedPaste": false, "repl.workspace": true, ...settings };
  const repl = new ReplController({
    setting: (k) => values[k],
    workspace: { getActiveTextEditor: () => editor },
    commands: { dispatch: (el, name) => log.dispatched.push([el, name]) },
    views: { getView: (e) => ({ view: e }) },
    notifications,
    fetchSymbols: async () => { if (symbolsError) throw symbolsError; return symbols; },
    bridge,
    ...deps,
  });
  repl.setService(service);
  return { repl, log, service };
}

describe("ReplController and the workspace bridge", () => {
  const editor = fakeEditor({ text: "x = 1", filePath: null });

  it("starts Julia with the helper's startup file", async () => {
    const bridge = { prepare: async () => ({ loadFile: "/tmp/ws.jl" }) };
    const { repl, log } = setup({ editor, bridge });
    await repl.openRepl(editor);
    expect(log.runs[0][0]).toBe("julia -L /tmp/ws.jl");
  });

  it("leaves the helper out when the setting is off", async () => {
    let called = 0;
    const bridge = { prepare: async () => { called++; return { loadFile: "/tmp/ws.jl" }; } };
    const { repl, log } = setup({ editor, bridge, settings: { "repl.workspace": false } });
    await repl.openRepl(editor);
    expect(called).toBe(0);
    expect(log.runs[0][0]).toBe("julia");
  });

  it("still starts the REPL, with a warning, when the bridge cannot be prepared", async () => {
    const bridge = { prepare: async () => { throw new Error("EADDRINUSE"); } };
    const { repl, log } = setup({ editor, bridge });
    expect(await repl.openRepl(editor)).toBe(true);
    expect(log.runs[0][0]).toBe("julia");
    expect(log.notes.some(([kind, msg]) => kind === "addWarning" && /EADDRINUSE/.test(msg))).toBe(true);
  });
});

describe("ReplController", () => {
  it("opens a terminal and starts Julia in it", async () => {
    const editor = fakeEditor({ text: "x = 1", filePath: null });
    const { repl, log } = setup({ editor, settings: { "repl.threads": "auto", "repl.flags": "-e 'using Revise'" } });
    expect(await repl.openRepl()).toBe(true);
    expect(log.open).toBe(1);
    expect(log.runs).toEqual([["julia --threads=auto -i -e 'using Revise'"]]);
  });

  it("starts the REPL in the file's project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-proj-"));
    try {
      fs.writeFileSync(path.join(dir, "Project.toml"), "");
      const { repl, log } = setup({ editor: fakeEditor({ text: "", filePath: path.join(dir, "a.jl") }) });
      await repl.openRepl();
      expect(log.runs[0][0]).toBe(`julia --project=${dir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains itself when there is no terminal service", async () => {
    const { repl, log, service } = setup({ editor: fakeEditor({ text: "x = 1" }) });
    repl.setService(service).dispose();
    expect(await repl.openRepl()).toBe(false);
    expect(log.notes[0][0]).toBe("addError");
    expect(log.notes[0][1]).toContain("terminal");
  });

  it("starts the REPL on first send, then just types the code", async () => {
    const editor = fakeEditor({ text: "a = 1\nb = 2", selection: [[0, 0], [1, 5]] });
    const { repl, log } = setup({ editor });
    await repl.sendSelectionOrDefinition();
    expect(log.open).toBe(1);
    expect(log.runs).toEqual([["julia"], ["a = 1", "b = 2"]]);
    await repl.sendSelectionOrDefinition();
    expect(log.open).toBe(1);
    expect(log.runs.length).toBe(3);
  });

  it("sends a bracketed paste when asked", async () => {
    const editor = fakeEditor({ text: "a = 1\nb = 2", selection: [[0, 0], [1, 5]] });
    const { repl, log } = setup({ editor, settings: { "repl.bracketedPaste": true } });
    await repl.sendSelectionOrDefinition();
    expect(log.runs[1]).toEqual(["\u001b[200~a = 1\nb = 2\u001b[201~"]);
  });

  it("can use the terminal package's run-selected-text command instead, restoring the selection", async () => {
    const original = [[1, 0], [1, 0]];
    const editor = fakeEditor({ text: "a = 1\nb = 2", cursor: [1, 0], selection: original });
    const { repl, log } = setup({ editor, settings: { "repl.sendVia": "command" }, symbols: [] });
    await repl.sendSelectionOrDefinition();
    expect(log.dispatched.map((d) => d[1])).toEqual(["terminal:run-selected-text"]);
    expect(log.dispatched[0][0]).toEqual({ view: editor });
    expect(log.runs).toEqual([["julia"]]); // only the start-up went through the service
    expect(editor.selections).toEqual([original]);
  });

  describe("without a selection", () => {
    const text = "x = 1\nfunction f(a)\n    a + 1\nend\ny = 2";
    const symbols = [{ name: "f", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 3, character: 3 } } }];

    it("sends the definition around the cursor", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text, cursor: [2, 4] }), symbols });
      await repl.sendSelectionOrDefinition();
      expect(log.runs[1]).toEqual(["function f(a)", "    a + 1", "end"]);
    });

    it("falls back to the current line between definitions, with no symbols, or if the request fails", async () => {
      for (const extra of [{ symbols }, { symbols: null }, { symbolsError: new Error("boom") }]) {
        const { repl, log } = setup({ editor: fakeEditor({ text, cursor: [0, 2] }), ...extra });
        await repl.sendSelectionOrDefinition();
        expect(log.runs[1]).toEqual(["x = 1"]);
      }
    });

    it("sends nothing for an empty line", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "x = 1\n\ny = 2", cursor: [1, 0] }), symbols: [] });
      await repl.sendSelectionOrDefinition();
      expect(log.runs).toEqual([]);
    });
  });

  describe("module-aware evaluation through the helper", () => {
    const r = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
    const symbols = [
      { name: "Outer", kind: 2, range: r(0, 0, 8, 3), children: [
        { name: "g", kind: 12, range: r(2, 2, 4, 5), children: [] },
        { name: "Inner", kind: 2, range: r(5, 2, 7, 5), children: [] },
      ] },
      { name: "top", kind: 12, range: r(10, 0, 12, 3), children: [] },
    ];
    const text = ["module Outer", "", "  function g()", "    1", "  end", "  module Inner", "    z = 3", "  end", "end", "", "function top()", "  2", "end"].join("\n");

    // A bridge that records what it was asked to write.
    const fakeBridge = (over = {}) => {
      const written = [];
      return Object.assign({
        written,
        prepare: async () => ({ loadFile: "/tmp/ws.jl" }),
        canEval: () => true,
        whenConnected: async () => ({}),
        evalCode: async (req) => { written.push(req); },
      }, over);
    };
    const withBridge = (over, extra = {}) => {
      const bridge = fakeBridge(over);
      return { bridge, ...setup({ editor: fakeEditor({ text, filePath: "/w/a.jl", ...extra.editor }), symbols, bridge, ...extra.setup }) };
    };

    it("runs test code in Main through the helper, or types it without one", async () => {
      const { repl, log, bridge } = withBridge({});
      expect(await repl.runInMain("using Test\nnothing;", { file: "/w/t.jl", line: 3 })).toBe(true);
      expect(bridge.written).toEqual([{ module: "Main", file: "/w/t.jl", line: 3, code: "using Test\nnothing;" }]);
      expect(log.runs.length).toBe(1); // only the start of the REPL

      const typed = setup({ editor: fakeEditor({ text: "" }) });
      await typed.repl.runInMain("using Test\nnothing;");
      expect(typed.log.runs[1]).toEqual(["using Test", "nothing;"]);
    });

    it("hands the code, module, file and line to the helper instead of typing it", async () => {
      const { repl, log, bridge } = withBridge({}, { editor: { cursor: [3, 4] } });
      await repl.sendSelectionOrDefinition();
      expect(log.runs.length).toBe(1); // only the start of the REPL was typed
      expect(bridge.written).toEqual([{ module: "Main.Outer", file: "/w/a.jl", line: 3, code: "  function g()\n    1\n  end" }]);
    });

    it("evaluates top-level code in Main", async () => {
      const { repl, bridge } = withBridge({}, { editor: { cursor: [11, 2] } });
      await repl.sendSelectionOrDefinition();
      expect(bridge.written[0].module).toBe("Main");
      expect(bridge.written[0].line).toBe(11);
    });

    it("finds the module of a selection", async () => {
      const { repl, bridge } = withBridge({}, { editor: { selection: [[6, 4], [6, 9]] } });
      await repl.sendSelectionOrDefinition();
      expect(bridge.written[0]).toEqual({ module: "Main.Outer.Inner", file: "/w/a.jl", line: 7, code: "z = 3" });
    });

    it("does not put a whole module inside itself", async () => {
      const { repl, bridge } = withBridge({}, { editor: { selection: [[5, 2], [7, 5]] } });
      await repl.sendSelectionOrDefinition();
      expect(bridge.written[0].module).toBe("Main.Outer");
    });

    it("sends a cell with its module", async () => {
      const { repl, bridge } = withBridge({}, { editor: { cursor: [3, 0] } });
      await repl.sendCell();
      expect(bridge.written.length).toBe(1);
      expect(bridge.written[0].line).toBe(1);
    });

    it("marks buffers without a file", async () => {
      const { repl, bridge } = withBridge({}, { editor: { filePath: null, cursor: [11, 0] } });
      await repl.sendSelectionOrDefinition();
      expect(bridge.written[0].file).toBe("");
    });

    it("types the code as it is when there is no helper, it does not connect, or the setting is off", async () => {
      const cases = [
        [{ canEval: () => false }, {}],
        [{ whenConnected: async () => null }, {}],
        [{}, { setup: { settings: { "repl.moduleAware": false } } }],
        [{}, { setup: { settings: { "repl.workspace": false } } }],
      ];
      for (const [over, extra] of cases) {
        const { repl, log, bridge } = withBridge(over, { editor: { cursor: [3, 4] }, ...extra });
        await repl.sendSelectionOrDefinition();
        expect(bridge.written).toEqual([]);
        expect(log.runs[log.runs.length - 1]).toEqual(["  function g()", "    1", "  end"]);
      }
    });

    it("uses Main when JETLS has no answer", async () => {
      for (const extra of [{ setup: { symbolsError: new Error("boom") } }, { setup: { symbols: null } }]) {
        const { repl, bridge } = withBridge({}, { editor: { selection: [[6, 4], [6, 9]] }, ...extra });
        await repl.sendSelectionOrDefinition();
        expect(bridge.written[0].module).toBe("Main");
      }
    });

    it("falls back to typing if the helper cannot take the code", async () => {
      const { repl, log } = withBridge({ evalCode: async () => { throw new Error("disk full"); } }, { editor: { cursor: [11, 2] } });
      await repl.sendSelectionOrDefinition();
      expect(log.runs[log.runs.length - 1]).toEqual(["function top()", "  2", "end"]);
    });

    it("does not type the code as well when the REPL is too busy to answer", async () => {
      const busy = Object.assign(new Error("busy"), { code: "timeout" });
      const { repl, log } = withBridge({ evalCode: async () => { throw busy; } }, { editor: { cursor: [11, 2] } });
      await repl.sendSelectionOrDefinition();
      expect(log.runs.length).toBe(1);
      expect(log.notes.map((n) => n[0])).toEqual(["addWarning"]);
    });

    it("also advances", async () => {
      const { repl, log } = withBridge({}, { editor: { cursor: [11, 2] } });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(log.runs.length).toBe(1);
    });

    it("tells the helper which package a file belongs to", async () => {
      const pkg = { name: "MyPkg", uuid: "6c3f9b2e-1d4a-4e8b-9f0a-2b7c5d8e1a34", dir: "/w" };
      const seen = [];
      const packageOf = (file) => { seen.push(file); return pkg; };
      const { repl, bridge } = withBridge({}, { editor: { cursor: [11, 2] }, setup: { deps: { packageOf } } });
      await repl.sendSelectionOrDefinition();
      expect(seen).toEqual(["/w/a.jl"]);
      expect(bridge.written[0]).toEqual({
        module: "Main", file: "/w/a.jl", line: 11, code: "function top()\n  2\nend",
        package: { name: "MyPkg", uuid: "6c3f9b2e-1d4a-4e8b-9f0a-2b7c5d8e1a34" },
      });
    });

    it("sends no package for unsaved buffers, files outside a package, or when the lookup fails", async () => {
      const cases = [
        { editor: { filePath: null, cursor: [11, 2] }, packageOf: () => { throw new Error("should not be asked"); } },
        { editor: { cursor: [11, 2] }, packageOf: () => null },
        { editor: { cursor: [11, 2] }, packageOf: () => { throw new Error("EACCES"); } },
      ];
      for (const c of cases) {
        const { repl, bridge } = withBridge({}, { editor: c.editor, setup: { deps: { packageOf: c.packageOf } } });
        await repl.sendSelectionOrDefinition();
        expect(bridge.written.length).toBe(1);
        expect("package" in bridge.written[0]).toBe(false);
      }
    });
  });

  describe("when the REPL exits", () => {
    // A bridge whose helper connection can be ended by the spec.
    const endingBridge = () => {
      const listeners = new Set();
      return {
        prepare: async () => ({ loadFile: "/tmp/ws.jl" }),
        canEval: () => false,
        onDidDisconnect: (fn) => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
        disconnect: () => [...listeners].forEach((fn) => fn()),
        listeners,
      };
    };

    it("starts a new REPL on the next send instead of typing into whatever terminal is active", async () => {
      const bridge = endingBridge();
      const editor = fakeEditor({ text: "x = 1", filePath: null });
      const { repl, log } = setup({ editor, bridge });
      await repl.sendSelectionOrDefinition();
      expect(log.open).toBe(1);
      await repl.sendSelectionOrDefinition();
      expect(log.open).toBe(1); // still running: the code is just sent
      bridge.disconnect();
      expect(repl.started).toBe(false);
      await repl.sendSelectionOrDefinition();
      expect(log.open).toBe(2);
      expect(log.runs.map((r) => r[0])).toEqual(["julia -L /tmp/ws.jl", "x = 1", "x = 1", "julia -L /tmp/ws.jl", "x = 1"]);
    });

    it("stops listening when disposed", () => {
      const bridge = endingBridge();
      const { repl } = setup({ editor: fakeEditor({ text: "" }), bridge });
      expect(bridge.listeners.size).toBe(1);
      repl.dispose();
      expect(bridge.listeners.size).toBe(0);
    });

    it("works with a bridge that cannot report exits", () => {
      const { repl } = setup({ editor: fakeEditor({ text: "" }), bridge: { prepare: async () => ({ loadFile: null }) } });
      expect(() => repl.dispose()).not.toThrow();
    });
  });

  describe("sending and advancing", () => {
    const text = "x = 1\n\n# a comment\nfunction f(a)\n    a + 1\nend\n\n    y = 2\n# last";
    const symbols = [{ name: "f", kind: 12, range: { start: { line: 3, character: 0 }, end: { line: 5, character: 3 } } }];

    it("moves to the next line of code after a line", async () => {
      const editor = fakeEditor({ text, cursor: [0, 3] });
      const { repl, log } = setup({ editor, symbols });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(log.runs[1]).toEqual(["x = 1"]);
      expect(editor.cursor).toEqual({ row: 3, column: 0 });
    });

    it("moves past a whole definition, to the first character of the next line", async () => {
      const editor = fakeEditor({ text, cursor: [4, 2] });
      const { repl, log } = setup({ editor, symbols });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(log.runs[1]).toEqual(["function f(a)", "    a + 1", "end"]);
      expect(editor.cursor).toEqual({ row: 7, column: 4 });
    });

    it("moves past a selection, also one that ends at the start of a line", async () => {
      const editor = fakeEditor({ text, selection: [[3, 0], [6, 0]] });
      const { repl, log } = setup({ editor });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(log.runs[1]).toEqual(["function f(a)", "    a + 1", "end"]);
      expect(editor.cursor).toEqual({ row: 7, column: 4 });
    });

    it("stays put after the last line of code", async () => {
      const editor = fakeEditor({ text, cursor: [7, 6] });
      const { repl } = setup({ editor, symbols });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(editor.cursor).toEqual({ row: 7, column: 6 });
    });

    it("moves on from an empty line without sending it", async () => {
      const editor = fakeEditor({ text, cursor: [1, 0] });
      const { repl, log } = setup({ editor, symbols });
      await repl.sendSelectionOrDefinition({ advance: true });
      expect(log.runs).toEqual([]);
      expect(editor.cursor).toEqual({ row: 3, column: 0 });
    });

    it("does not move without `advance`", async () => {
      const editor = fakeEditor({ text, cursor: [0, 3] });
      const { repl } = setup({ editor, symbols });
      await repl.sendSelectionOrDefinition();
      expect(editor.cursor).toEqual({ row: 0, column: 3 });
    });
  });

  describe("cells", () => {
    const text = "## one\nx = 1\n\n## two\ny = 2\nz = 3\n\n## three\nw = 4";

    it("sends the cell around the cursor", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text, cursor: [5, 0] }) });
      await repl.sendCell();
      expect(log.runs[1]).toEqual(["## two", "y = 2", "z = 3"]);
    });

    it("can move on to the next cell afterwards", async () => {
      const editor = fakeEditor({ text, cursor: [1, 0] });
      const { repl } = setup({ editor });
      await repl.sendCell({ advance: true });
      expect(editor.cursor.row).toBe(3);
    });

    it("moves between cells without sending anything", () => {
      const editor = fakeEditor({ text, cursor: [4, 0] });
      const { repl, log } = setup({ editor });
      repl.moveToCell(1);
      expect(editor.cursor.row).toBe(7);
      repl.moveToCell(-1);
      expect(editor.cursor.row).toBe(3);
      repl.moveToCell(-1);
      expect(editor.cursor.row).toBe(0);
      repl.moveToCell(-1);
      expect(editor.cursor.row).toBe(0);
      expect(log.runs).toEqual([]);
    });
  });

  describe("files and environments", () => {
    it("includes the saved file, saving it first if needed", async () => {
      const editor = fakeEditor({ text: "x = 1", filePath: "/w/a.jl", modified: true });
      const { repl, log } = setup({ editor });
      await repl.sendFile();
      expect(editor.saved).toBe(true);
      expect(log.runs[1]).toEqual(['include(raw"/w/a.jl")']);
    });

    it("sends the buffer's text when the file has no path yet", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "x = 1\ny = 2" }) });
      await repl.sendFile();
      expect(log.runs[1]).toEqual(["x = 1", "y = 2"]);
    });

    it("activates the file's project, or says there is none", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-act-"));
      try {
        fs.writeFileSync(path.join(dir, "Project.toml"), "");
        const a = setup({ editor: fakeEditor({ text: "", filePath: path.join(dir, "a.jl") }) });
        await a.repl.activateEnvironment();
        expect(a.log.runs[a.log.runs.length - 1]).toEqual([`import Pkg; Pkg.activate(raw"${dir}")`]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const b = setup({ editor: fakeEditor({ text: "", filePath: "/nonexistent-root-xyz/a.jl" }) });
      await b.repl.activateEnvironment();
      expect(b.log.notes[0][0]).toBe("addWarning");
      expect(b.log.runs).toEqual([]);
    });
  });

  describe("working folder and environments", () => {
    const sent = (log) => log.runs[log.runs.length - 1];

    it("works in the folder of the file", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "", filePath: "/w/pkg/src/a.jl" }) });
      await repl.workInCurrentFolder();
      expect(sent(log)).toEqual(['cd(raw"/w/pkg/src")']);
    });

    it("asks for a saved file when there is no folder yet", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "", filePath: null }) });
      await repl.workInCurrentFolder();
      await repl.activateEnvironmentInCurrentFolder();
      expect(log.runs).toEqual([]);
      expect(log.notes.map((n) => n[0])).toEqual(["addWarning", "addWarning"]);
    });

    it("works in Pulsar's project folder for the file, or says it has none", async () => {
      const editor = fakeEditor({ text: "", filePath: "/w/pkg/src/a.jl" });
      const a = setup({ editor, deps: { projectRoot: (f) => (f.startsWith("/w/pkg") ? "/w/pkg" : null) } });
      await a.repl.workInProjectFolder();
      expect(sent(a.log)).toEqual(['cd(raw"/w/pkg")']);
      const b = setup({ editor, deps: { projectRoot: () => null } });
      await b.repl.workInProjectFolder();
      expect(b.log.runs).toEqual([]);
      expect(b.log.notes[0][0]).toBe("addWarning");
    });

    it("works in the home folder", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "" }) });
      await repl.workInHomeFolder();
      expect(sent(log)).toEqual(["cd()"]);
    });

    it("works in a folder the user picks, or nothing if they cancel", async () => {
      const editor = fakeEditor({ text: "" });
      const a = setup({ editor, deps: { pickFolder: async () => "/data/run 1" } });
      await a.repl.selectWorkingFolder();
      expect(sent(a.log)).toEqual(['cd(raw"/data/run 1")']);
      const b = setup({ editor, deps: { pickFolder: async () => null } });
      await b.repl.selectWorkingFolder();
      expect(b.log.runs).toEqual([]);
    });

    it("activates the environment of the file's folder or of its parent", async () => {
      const editor = fakeEditor({ text: "", filePath: "/w/pkg/test/a.jl" });
      const { repl, log } = setup({ editor });
      await repl.activateEnvironmentInCurrentFolder();
      expect(sent(log)).toEqual(['import Pkg; Pkg.activate(raw"/w/pkg/test")']);
      await repl.activateEnvironmentInParentFolder();
      expect(sent(log)).toEqual(['import Pkg; Pkg.activate(raw"/w/pkg")']);
    });

    it("activates the default environment", async () => {
      const { repl, log } = setup({ editor: fakeEditor({ text: "" }) });
      await repl.activateDefaultEnvironment();
      expect(sent(log)).toEqual(["import Pkg; Pkg.activate()"]);
    });

    describe("shared environments", () => {
      let depot, saved;
      beforeEach(() => {
        depot = fs.mkdtempSync(path.join(os.tmpdir(), "repl-depot-"));
        saved = process.env.JULIA_DEPOT_PATH;
        process.env.JULIA_DEPOT_PATH = depot;
      });
      afterEach(() => {
        if (saved === undefined) delete process.env.JULIA_DEPOT_PATH; else process.env.JULIA_DEPOT_PATH = saved;
        fs.rmSync(depot, { recursive: true, force: true });
      });

      it("activates the one the user picks", async () => {
        for (const name of ["v1.11", "plots"]) {
          fs.mkdirSync(path.join(depot, "environments", name), { recursive: true });
          fs.writeFileSync(path.join(depot, "environments", name, "Project.toml"), "");
        }
        let offered;
        const { repl, log } = setup({ editor: fakeEditor({ text: "" }), deps: { pick: async (items) => { offered = items; return "plots"; } } });
        await repl.selectEnvironment();
        expect(offered).toEqual(["plots", "v1.11"]);
        expect(sent(log)).toEqual(['import Pkg; Pkg.activate(raw"plots"; shared=true)']);
      });

      it("says so when there are none", async () => {
        let asked = false;
        const { repl, log } = setup({ editor: fakeEditor({ text: "" }), deps: { pick: async () => { asked = true; return null; } } });
        await repl.selectEnvironment();
        expect(asked).toBe(false);
        expect(log.notes[0][0]).toBe("addInfo");
      });
    });
  });

  it("asks for a Julia file when no editor is open", async () => {
    const { repl, log } = setup({ editor: undefined });
    await repl.sendCell();
    expect(log.notes[0][0]).toBe("addWarning");
  });
});
