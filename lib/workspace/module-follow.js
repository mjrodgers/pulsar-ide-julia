// "Follow editor" for the workspace pane: show the variables of the module the cursor is in.
//
// The pure helpers need only the document symbols JETLS reports (kind 2 = Module, nested via `children`) and the
// names of the modules the REPL has loaded. ModuleFollower wires them to the active editor.
const { setTimeout, clearTimeout } = require("timers");

const FOLLOW = "@follow";
const MODULE_KIND = 2;

const before = (a, b) => a.line < b.line || (a.line === b.line && a.character <= b.character);
const contains = (range, pos) => !!range && !!range.start && !!range.end && before(range.start, pos) && before(pos, range.end);

// ["Foo", "Bar"] for a cursor inside `module Foo … module Bar … end … end`; [] at top level.
function enclosingModulePath(symbols, row, column) {
  const out = [];
  if (!Array.isArray(symbols)) return out;
  const pos = { line: row, character: column };
  let level = symbols;
  for (;;) {
    const next = level.find((s) => s && s.kind === MODULE_KIND && contains(s.range, pos));
    if (!next) return out;
    out.push(String(next.name));
    level = Array.isArray(next.children) ? next.children : [];
  }
}

// The deepest module of `parts` that the REPL knows. `module Foo` in a file that was never included does not exist
// there yet, so fall back to the enclosing one that does (in the end, Main).
function chooseExistingModule(names, parts) {
  const known = new Set(names);
  for (let n = parts.length; n > 0; n--) {
    const candidate = "Main." + parts.slice(0, n).join(".");
    if (known.has(candidate)) return candidate;
  }
  return "Main";
}

const candidateFor = (parts) => (parts.length ? "Main." + parts.join(".") : "Main");

class ModuleFollower {
  // deps: workspace (observeActiveTextEditor), fetchSymbols(editor), onPath(parts) and isActive()
  constructor({ workspace, fetchSymbols, onPath, isActive, delay = 300 }) {
    this.workspace = workspace;
    this.fetchSymbols = fetchSymbols;
    this.onPath = onPath;
    this.isActive = isActive;
    this.delay = delay;
    this.editor = null;
    this.timer = null;
    this.cache = null; // {editor, symbols}
    this.subscriptions = [];
    this.editorSubscriptions = [];
    this.runCount = 0;
    this.disposed = false;
  }

  start() {
    this.subscriptions.push(this.workspace.observeActiveTextEditor((editor) => this.watch(editor)));
  }

  // Look again as soon as following starts (the user picked "Follow editor", or a REPL connected while it was on).
  watchModel(model) {
    let was = model.following;
    const off = model.onDidChange(() => {
      const now = model.following;
      if (now && !was) this.schedule();
      was = now;
    });
    this.subscriptions.push({ dispose: off });
    if (was) this.schedule();
  }

  isJulia(editor) {
    const g = editor && editor.getGrammar && editor.getGrammar();
    return !!g && g.scopeName === "source.julia";
  }

  watch(editor) {
    this.editorSubscriptions.forEach((d) => d.dispose());
    this.editorSubscriptions = [];
    this.cache = null;
    this.editor = editor && this.isJulia(editor) ? editor : null;
    if (!this.editor) return;
    this.editorSubscriptions.push(
      this.editor.onDidChangeCursorPosition(() => this.schedule()),
      this.editor.onDidStopChanging(() => { this.cache = null; this.schedule(); })
    );
    this.schedule();
  }

  schedule() {
    if (this.disposed || !this.editor) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, this.delay);
  }

  async run() {
    const editor = this.editor;
    if (!editor || this.disposed || !this.isActive()) return;
    const mine = ++this.runCount;
    let symbols;
    try {
      if (this.cache && this.cache.editor === editor) symbols = this.cache.symbols;
      else {
        symbols = await this.fetchSymbols(editor);
        if (mine !== this.runCount || editor !== this.editor) return;
        this.cache = { editor, symbols };
      }
    } catch (e) {
      return; // the server is not ready; the next cursor move tries again
    }
    if (!Array.isArray(symbols)) return;
    const at = editor.getCursorBufferPosition();
    this.onPath(enclosingModulePath(symbols, at.row, at.column));
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((d) => d.dispose());
    this.editorSubscriptions.forEach((d) => d.dispose());
    this.subscriptions = [];
    this.editorSubscriptions = [];
  }
}

module.exports = { FOLLOW, enclosingModulePath, chooseExistingModule, candidateFor, ModuleFollower };
