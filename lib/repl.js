// A Julia REPL in Pulsar's built-in terminal, driven through the `terminal` service
// (https://github.com/pulsar-edit/terminal): open() starts a terminal, run(lines) types lines
// into the most recently used one. The service cannot read the terminal's output or write to
// its pty, so this is "type into a REPL", not Juno's inline results.
//
// Everything that does not need Pulsar is a pure function at the top, so it is unit-tested
// in plain Node; ReplController at the bottom does the editor/terminal wiring.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { rawString } = require("./julia-string");
const env = require("./environments");
const { enclosingModulePath, candidateFor } = require("./workspace/module-follow");
// Node's own timers: Pulsar's spec runner replaces the window's with a mock clock.
const { setTimeout: later, clearTimeout: cancel } = require("timers");

// How long sending waits for JETLS to say which module the code is in, and for a new REPL's helper to connect.
const SYMBOLS_TIMEOUT = 2000;
const HELPER_TIMEOUT = 20000;

// ----------------------------------------------------------------------------- command line

// Quote one argument for the shell the terminal starts. POSIX shells: single quotes.
// Windows (cmd and PowerShell both accept double quotes for plain arguments): double quotes.
function quoteArg(arg, platform = process.platform) {
  const s = String(arg);
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  if (platform === "win32") return `"${s.replace(/"/g, '""')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function expandHome(p, homedir = os.homedir()) {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

// Nearest directory at or above `startDir` that has a Project.toml / JuliaProject.toml.
function findProjectDir(startDir, exists = fs.existsSync) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    if (exists(path.join(dir, "Project.toml")) || exists(path.join(dir, "JuliaProject.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const hasFlag = (flags, ...names) => names.some((n) => new RegExp(`(^|\\s)${n}(\\s|=|$)`).test(flags));

// The shell command that starts the REPL.
//  environment: "" -> the active file's project (if it has one); "@." / "@v1.12" / "@name" -> as is;
//               anything else is a directory.
//  loadFile: a Julia file to load at startup (`-L`), used to connect the workspace pane.
//  flags: raw text appended as written, so quoting like -e 'using Revise' just works.
//         `-i` is added when -e/--eval is used without it, or Julia would exit after the -e.
function buildReplCommand({
  juliaPath = "",
  threads = "",
  environment = "",
  projectDir = null,
  flags = "",
  loadFile = null,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const exe = juliaPath ? quoteArg(expandHome(juliaPath, homedir), platform) : "julia";
  const parts = [exe];
  if (threads) parts.push(`--threads=${quoteArg(threads, platform)}`);

  let project = null;
  if (environment) project = environment.startsWith("@") ? environment : expandHome(environment, homedir);
  else if (projectDir) project = projectDir;
  if (project) parts.push(`--project=${quoteArg(project, platform)}`);
  if (loadFile) parts.push("-L", quoteArg(loadFile, platform)); // the workspace helper's startup file

  const extra = String(flags || "").trim();
  if (extra) {
    if (hasFlag(extra, "-e", "--eval") && !hasFlag(extra, "-i", "--interactive")) parts.push("-i");
    parts.push(extra);
  }
  return parts.join(" ");
}

const includeCommand = (file) => `include(${rawString(file)})`;
const { activateCommand } = env;

// What to type: one command per line (like typing it), or the whole text as one bracketed paste.
function codeToCommands(text, { bracketedPaste = false } = {}) {
  const lines = String(text).replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];
  return bracketedPaste ? [`\u001b[200~${lines.join("\n")}\u001b[201~`] : lines;
}

// ----------------------------------------------------------------------------- cells

// Juno's cell markers: lines starting with ##, #--- or # %%.
const CELL_MARKER = /^\s*(##|#---|# %%)/;
const isCellMarker = (line) => CELL_MARKER.test(String(line));

// The cell containing `row`: from its marker line (or the top of the file) to the line before
// the next marker, minus trailing blank lines. nextCellRow is the next marker, if any.
function findCell(lines, row) {
  let start = 0;
  for (let r = Math.min(row, lines.length - 1); r >= 0; r--) {
    if (isCellMarker(lines[r])) { start = r; break; }
  }
  let nextCellRow = null;
  for (let r = start + 1; r < lines.length; r++) {
    if (isCellMarker(lines[r])) { nextCellRow = r; break; }
  }
  let end = (nextCellRow === null ? lines.length : nextCellRow) - 1;
  while (end > start && String(lines[end]).trim() === "") end--;
  return { startRow: start, endRow: end, nextCellRow };
}

function nextCellMarkerRow(lines, row) {
  for (let r = row + 1; r < lines.length; r++) if (isCellMarker(lines[r])) return r;
  return null;
}

function previousCellMarkerRow(lines, row) {
  for (let r = row - 1; r >= 0; r--) if (isCellMarker(lines[r])) return r;
  return null;
}

// ----------------------------------------------------------------------------- definitions

const MODULE_KIND = 2;
const MACRO_PREFIX_ONLY = /^\s*(?:[\w.]*@[\w!]+\s*)*$/; // JETLS may start the range on the space after the macro

// The top-level definition (function, struct, const, loop, ...) containing `row`, from the
// server's DocumentSymbol[] reply; modules are looked into rather than returned. JETLS ranges
// start after a leading macro (`@inline f(x) = ...`, `@kwdef struct ...`), which would change
// what is evaluated, so a start preceded only by macros is moved back to column 0.
// Returns { start: {row, column}, end: {row, column} } or null.
function findDefinition(symbols, row, lineAt = () => "") {
  const walk = (list) => {
    for (const sym of list || []) {
      const r = sym.range;
      if (!r || row < r.start.line || row > r.end.line) continue;
      if (sym.kind === MODULE_KIND) return walk(sym.children);
      let column = r.start.character;
      const before = String(lineAt(r.start.line) || "").slice(0, column);
      if (column > 0 && MACRO_PREFIX_ONLY.test(before)) column = 0;
      return { start: { row: r.start.line, column }, end: { row: r.end.line, column: r.end.character } };
    }
    return null;
  };
  return walk(symbols);
}

// The first row after `row` that holds code: not blank, not only a comment (so cell markers are skipped too).
function nextCodeRow(lines, row) {
  for (let r = row + 1; r < lines.length; r++) {
    const t = lines[r].trim();
    if (t && !t.startsWith("#")) return r;
  }
  return null;
}

// The last row a range really covers: a selection that ends at column 0 (whole lines selected) stops one row earlier.
function lastRowOf(start, end) {
  return end.column === 0 && end.row > start.row ? end.row - 1 : end.row;
}

// ----------------------------------------------------------------------------- controller

// Wires the above to Pulsar. Everything Pulsar-specific comes in through `deps` so the
// Pulsar-only spec can use a fake terminal service.
//   deps.setting(key), deps.workspace, deps.commands, deps.notifications,
//   deps.fetchSymbols(editor) -> DocumentSymbol[] | null
class ReplController {
  constructor(deps) {
    this.deps = deps;
    this.service = null;
    this.started = false;
  }

  // Called with the `terminal` service; returns a disposable-like object.
  setService(service) {
    this.service = service;
    return { dispose: () => { if (this.service === service) { this.service = null; this.started = false; } } };
  }

  notify(kind, message) { this.deps.notifications[kind](`Julia REPL: ${message}`); }

  requireService() {
    if (this.service) return this.service;
    this.notify("addError", "no terminal service. Enable Pulsar's built-in `terminal` package (or x-terminal-reloaded).");
    return null;
  }

  activeEditor() {
    const editor = this.deps.workspace.getActiveTextEditor();
    if (!editor) this.notify("addWarning", "open a Julia file first.");
    return editor;
  }

  replCommand(editor, { loadFile = null } = {}) {
    const filePath = editor && editor.getPath();
    return buildReplCommand({
      loadFile,
      juliaPath: this.deps.setting("replJuliaPath"),
      threads: this.deps.setting("replThreads"),
      environment: this.deps.setting("replEnvironment"),
      projectDir: findProjectDir(filePath ? path.dirname(filePath) : null),
      flags: this.deps.setting("replFlags"),
    });
  }

  async openRepl(editor = this.deps.workspace.getActiveTextEditor()) {
    const service = this.requireService();
    if (!service) return false;
    try {
      const { loadFile } = await this.prepareWorkspace();
      await service.open();
      await service.run([this.replCommand(editor, { loadFile })]);
      this.started = true;
      return true;
    } catch (e) {
      this.notify("addError", `could not start: ${(e && e.message) || e}`);
      return false;
    }
  }

  // Lets the REPL we are about to start report its variables to the workspace pane. Never blocks starting it.
  async prepareWorkspace() {
    const bridge = this.deps.bridge;
    if (!bridge || !this.deps.setting("replWorkspace")) return { loadFile: null };
    try {
      return await bridge.prepare();
    } catch (e) {
      this.notify("addWarning", `the workspace pane will not follow this REPL (${(e && e.message) || e}).`);
      return { loadFile: null };
    }
  }

  async ensureStarted(editor) {
    return this.started || this.openRepl(editor);
  }

  flash(editor, range) {
    try {
      const marker = editor.markBufferRange(range, { invalidate: "never" });
      editor.decorateMarker(marker, { type: "highlight", class: "pulsar-ide-julia-sent" });
      setTimeout(() => marker.destroy(), 250);
    } catch (e) { /* purely cosmetic */ }
  }

  // The document symbols of the editor, or null if the server does not answer soon (sending must not hang on it).
  async symbolsOf(editor) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(this.deps.fetchSymbols(editor)),
        new Promise((resolve) => { timer = later(() => resolve(null), SYMBOLS_TIMEOUT); }),
      ]);
    } catch (e) {
      return null;
    } finally {
      cancel(timer);
    }
  }

  // With the Julia helper running in the REPL, the code is handed over in a file and a short call is typed instead:
  // `__pulsar_eval__(3)`. Julia then evaluates it in the module the code sits in, with this file's name and line
  // numbers, and the REPL shows the result as usual. Returns that call, or null to type the code as it is.
  async evalCall(text, { editor, range, symbols }) {
    const bridge = this.deps.bridge;
    if (!bridge || !bridge.canEval || !bridge.canEval() || !editor || !range) return null;
    if (this.deps.setting("replModuleAware") === false || this.deps.setting("replWorkspace") === false) return null;
    if (!(await bridge.whenConnected(HELPER_TIMEOUT))) return null;
    const start = Array.isArray(range) ? { row: range[0][0], column: range[0][1] } : range.start;
    if (symbols === undefined) symbols = await this.symbolsOf(editor);
    try {
      return bridge.writeEval({
        module: candidateFor(enclosingModulePath(symbols, start.row, start.column, { strict: true })),
        file: editor.getPath() || "",
        line: start.row + 1,
        code: text,
      });
    } catch (e) {
      return null;
    }
  }

  // Types `text` into the REPL. With "command" mode and a buffer range, the range is selected
  // and the terminal package's own run-selected-text command used (no approval prompt).
  // `symbols` (optional) are the editor's document symbols, when the caller already has them.
  async send(text, { editor, range, symbols } = {}) {
    const commands = codeToCommands(text, { bracketedPaste: this.deps.setting("replBracketedPaste") === true });
    if (commands.length === 0) return false;
    if (!this.requireService()) return false;
    if (!(await this.ensureStarted(editor))) return false;

    if (editor && range) this.flash(editor, range);
    const call = await this.evalCall(text, { editor, range, symbols });
    if (call) {
      try {
        await this.service.run([call]);
        return true;
      } catch (e) {
        this.notify("addError", `could not send: ${(e && e.message) || e}`);
        return false;
      }
    }
    if (editor && range && this.deps.setting("replSendVia") === "command") {
      const saved = editor.getSelectedBufferRanges();
      try {
        editor.setSelectedBufferRange(range);
        this.deps.commands.dispatch(this.deps.views.getView(editor), "terminal:run-selected-text");
      } finally {
        editor.setSelectedBufferRanges(saved);
      }
      return true;
    }
    try {
      await this.service.run(commands);
      return true;
    } catch (e) {
      this.notify("addError", `could not send: ${(e && e.message) || e}`);
      return false;
    }
  }

  // --- commands ---------------------------------------------------------------------------

  // Moves the cursor to the next line of code after `row`, if there is one.
  advanceAfter(editor, row) {
    const lines = editor.getBuffer().getLines();
    const target = nextCodeRow(lines, row);
    if (target !== null) editor.setCursorBufferPosition([target, Math.max(0, lines[target].search(/\S/))]);
  }

  // Sends the selection, or the definition (or else the line) around the cursor. With `advance` the cursor then
  // moves on to the next line of code, as "run and move" in Juno did.
  async sendSelectionOrDefinition({ advance = false } = {}) {
    const editor = this.activeEditor();
    if (!editor) return;
    const selected = editor.getSelectedBufferRange();
    if (!selected.isEmpty()) {
      if (advance) this.advanceAfter(editor, lastRowOf(selected.start, selected.end));
      return this.send(editor.getTextInBufferRange(selected), { editor, range: selected });
    }

    const row = editor.getCursorBufferPosition().row;
    let range = null;
    let endRow = row;
    let symbols = null;
    try {
      symbols = await this.symbolsOf(editor);
      const def = findDefinition(symbols, row, (r) => editor.lineTextForBufferRow(r));
      if (def) {
        range = [[def.start.row, def.start.column], [def.end.row, def.end.column]];
        endRow = lastRowOf(def.start, def.end);
      }
    } catch (e) { /* no symbols: fall back to the line */ }
    if (!range) range = [[row, 0], [row, editor.lineTextForBufferRow(row).length]];
    if (advance) this.advanceAfter(editor, endRow);
    return this.send(editor.getTextInBufferRange(range), { editor, range, symbols });
  }

  async sendCell({ advance = false } = {}) {
    const editor = this.activeEditor();
    if (!editor) return;
    const lines = editor.getBuffer().getLines();
    const row = editor.getCursorBufferPosition().row;
    const cell = findCell(lines, row);
    const range = [[cell.startRow, 0], [cell.endRow, lines[cell.endRow].length]];
    const sent = this.send(editor.getTextInBufferRange(range), { editor, range });
    if (advance && cell.nextCellRow !== null) editor.setCursorBufferPosition([cell.nextCellRow, 0]);
    return sent;
  }

  async sendFile() {
    const editor = this.activeEditor();
    if (!editor) return;
    if (!editor.getPath()) return this.send(editor.getText(), { editor });
    if (editor.isModified()) await editor.save();
    return this.send(includeCommand(editor.getPath()), { editor });
  }

  async activateEnvironment() {
    const editor = this.activeEditor();
    if (!editor) return;
    const dir = findProjectDir(editor.getPath() ? path.dirname(editor.getPath()) : null);
    if (!dir) return this.notify("addWarning", "this file is not inside a Julia project (no Project.toml found).");
    return this.send(activateCommand(dir), { editor });
  }

  // --- working folder and environment -----------------------------------------------------

  // The saved file of the active editor, or a warning.
  activeFile() {
    const editor = this.activeEditor();
    if (!editor) return null;
    if (!editor.getPath()) {
      this.notify("addWarning", "save the file first, so there is a folder to use.");
      return null;
    }
    return { editor, file: editor.getPath() };
  }

  async workInCurrentFolder() {
    const here = this.activeFile();
    if (here) return this.send(env.cdCommand(path.dirname(here.file)), { editor: here.editor });
  }

  async workInProjectFolder() {
    const here = this.activeFile();
    if (!here) return;
    const root = this.deps.projectRoot ? this.deps.projectRoot(here.file) : null;
    if (!root) return this.notify("addWarning", "this file is not inside one of Pulsar's project folders.");
    return this.send(env.cdCommand(root), { editor: here.editor });
  }

  async workInHomeFolder() {
    return this.send(env.cdHomeCommand(), { editor: this.deps.workspace.getActiveTextEditor() });
  }

  async selectWorkingFolder() {
    if (!this.deps.pickFolder) return;
    const dir = await this.deps.pickFolder();
    if (dir) return this.send(env.cdCommand(dir), { editor: this.deps.workspace.getActiveTextEditor() });
  }

  async activateEnvironmentInCurrentFolder() {
    const here = this.activeFile();
    if (here) return this.send(env.activateCommand(path.dirname(here.file)), { editor: here.editor });
  }

  async activateEnvironmentInParentFolder() {
    const here = this.activeFile();
    if (here) return this.send(env.activateCommand(path.dirname(path.dirname(here.file))), { editor: here.editor });
  }

  async activateDefaultEnvironment() {
    return this.send(env.activateDefaultCommand(), { editor: this.deps.workspace.getActiveTextEditor() });
  }

  // Asks which shared environment (`~/.julia/environments/<name>`) to activate.
  async selectEnvironment() {
    if (!this.deps.pick) return;
    const names = env.listSharedEnvironments(env.depotDir());
    if (names.length === 0) return this.notify("addInfo", "there are no shared environments in the Julia depot yet.");
    const name = await this.deps.pick(names, { placeholder: "Activate a shared environment" });
    if (name) return this.send(env.activateSharedCommand(name), { editor: this.deps.workspace.getActiveTextEditor() });
  }

  moveToCell(direction) {
    const editor = this.deps.workspace.getActiveTextEditor();
    if (!editor) return;
    const lines = editor.getBuffer().getLines();
    const row = editor.getCursorBufferPosition().row;
    const target = direction > 0 ? nextCellMarkerRow(lines, row) : previousCellMarkerRow(lines, row);
    if (target !== null) editor.setCursorBufferPosition([target, 0]);
  }
}

module.exports = {
  quoteArg, findProjectDir, buildReplCommand, includeCommand, activateCommand, codeToCommands,
  isCellMarker, findCell, nextCellMarkerRow, previousCellMarkerRow, findDefinition, nextCodeRow, ReplController,
};
