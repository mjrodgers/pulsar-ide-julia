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
//  flags: raw text appended as written, so quoting like -e 'using Revise' just works.
//         `-i` is added when -e/--eval is used without it, or Julia would exit after the -e.
function buildReplCommand({
  juliaPath = "",
  threads = "",
  environment = "",
  projectDir = null,
  flags = "",
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

  const extra = String(flags || "").trim();
  if (extra) {
    if (hasFlag(extra, "-e", "--eval") && !hasFlag(extra, "-i", "--interactive")) parts.push("-i");
    parts.push(extra);
  }
  return parts.join(" ");
}

// Julia string-literal-safe path for `include(...)` and friends.
const rawString = (p) => `raw"${String(p).replace(/"/g, '\\"')}"`;
const includeCommand = (file) => `include(${rawString(file)})`;
const activateCommand = (dir) => `import Pkg; Pkg.activate(${rawString(dir)})`;

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

  replCommand(editor) {
    const filePath = editor && editor.getPath();
    return buildReplCommand({
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
      await service.open();
      await service.run([this.replCommand(editor)]);
      this.started = true;
      return true;
    } catch (e) {
      this.notify("addError", `could not start: ${(e && e.message) || e}`);
      return false;
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

  // Types `text` into the REPL. With "command" mode and a buffer range, the range is selected
  // and the terminal package's own run-selected-text command used (no approval prompt).
  async send(text, { editor, range } = {}) {
    const commands = codeToCommands(text, { bracketedPaste: this.deps.setting("replBracketedPaste") === true });
    if (commands.length === 0) return false;
    if (!this.requireService()) return false;
    if (!(await this.ensureStarted(editor))) return false;

    if (editor && range) this.flash(editor, range);
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

  async sendSelectionOrDefinition() {
    const editor = this.activeEditor();
    if (!editor) return;
    const selected = editor.getSelectedBufferRange();
    if (!selected.isEmpty()) return this.send(editor.getTextInBufferRange(selected), { editor, range: selected });

    const row = editor.getCursorBufferPosition().row;
    let range = null;
    try {
      const def = findDefinition(await this.deps.fetchSymbols(editor), row, (r) => editor.lineTextForBufferRow(r));
      if (def) range = [[def.start.row, def.start.column], [def.end.row, def.end.column]];
    } catch (e) { /* no symbols: fall back to the line */ }
    if (!range) range = [[row, 0], [row, editor.lineTextForBufferRow(row).length]];
    return this.send(editor.getTextInBufferRange(range), { editor, range });
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
  isCellMarker, findCell, nextCellMarkerRow, previousCellMarkerRow, findDefinition, ReplController,
};
