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

function setup({ editor, settings = {}, symbols = null, symbolsError = null } = {}) {
  const log = { open: 0, runs: [], notes: [], dispatched: [] };
  const service = { open: async () => { log.open++; }, run: async (cmds) => { log.runs.push(cmds); return true; } };
  const notifications = new Proxy({}, { get: (_, kind) => (msg) => log.notes.push([kind, msg]) });
  const values = { replJuliaPath: "", replThreads: "", replEnvironment: "", replFlags: "", replSendVia: "service", replBracketedPaste: false, ...settings };
  const repl = new ReplController({
    setting: (k) => values[k],
    workspace: { getActiveTextEditor: () => editor },
    commands: { dispatch: (el, name) => log.dispatched.push([el, name]) },
    views: { getView: (e) => ({ view: e }) },
    notifications,
    fetchSymbols: async () => { if (symbolsError) throw symbolsError; return symbols; },
  });
  repl.setService(service);
  return { repl, log, service };
}

describe("ReplController", () => {
  it("opens a terminal and starts Julia in it", async () => {
    const editor = fakeEditor({ text: "x = 1", filePath: null });
    const { repl, log } = setup({ editor, settings: { replThreads: "auto", replFlags: "-e 'using Revise'" } });
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
    const { repl, log } = setup({ editor, settings: { replBracketedPaste: true } });
    await repl.sendSelectionOrDefinition();
    expect(log.runs[1]).toEqual(["\u001b[200~a = 1\nb = 2\u001b[201~"]);
  });

  it("can use the terminal package's run-selected-text command instead, restoring the selection", async () => {
    const original = [[1, 0], [1, 0]];
    const editor = fakeEditor({ text: "a = 1\nb = 2", cursor: [1, 0], selection: original });
    const { repl, log } = setup({ editor, settings: { replSendVia: "command" }, symbols: [] });
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

  it("asks for a Julia file when no editor is open", async () => {
    const { repl, log } = setup({ editor: undefined });
    await repl.sendCell();
    expect(log.notes[0][0]).toBe("addWarning");
  });
});
