// Running tests from the editor, two ways:
//
// * In the REPL: the `@testset` around the cursor, or the whole test file, runs in the REPL session, which already
//   has the package loaded, so it starts at once. Test files usually rely on `test/runtests.jl` for their setup
//   (`using Test`, `using TheirPackage`, test-only packages), so that setup is done first, the way runtests.jl and
//   `Pkg.test` would: `using Test`, the package's test environment made loadable, the package itself loaded, plus
//   any setup code from the settings.
// * With JETLS: JETLS offers its TestRunner (a fresh Julia process per run), macro expansion and inferred types as
//   code actions at the cursor; these commands ask for the code actions there and run the right one, so they can
//   have their own key bindings.
//
// The pure functions at the top need no Pulsar and are unit-tested in plain Node.
const fs = require("fs");
const path = require("path");
const { rawString } = require("./julia-string");
const { findProjectDir, readProject } = require("./julia/paths");

// ----------------------------------------------------------------------------- finding a testset

// A line that starts a `@testset` (possibly assigned, or qualified: `ts = Test.@testset ...`).
const TESTSET_LINE = /^(\s*)(?:[\p{L}_][\p{L}\p{N}_!]*\s*=\s*)?(?:[\p{L}_][\p{L}\p{N}_]*\.)*@testset\b/u;

// The code of a line without its comment and with the contents of strings blanked, so that words inside
// `@testset "for loops"` or a trailing `# end` do not count.
function codePart(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { quote = null; out += c; }
      continue;
    }
    if (c === "#") break;
    if (c === '"' || c === "`") quote = c;
    out += c;
  }
  return out;
}

// The last row of the `@testset` starting on `start` (indented `indent`), or null if it cannot be told. A testset
// whose body is a block (`begin`, `for`, `let`) ends at the first `end` at its own indentation; one with a call for
// its body (`@testset "x" check()`), or a block that closes on the same line, is one line.
function testsetEnd(lines, start, indent) {
  const head = codePart(lines[start]).replace(/^.*?@testset/, "");
  if (!/\b(begin|for|let)\b/.test(head) || /\bend\s*[;)]?\s*$/.test(head)) return start;
  for (let r = start + 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line.trim()) continue;
    const own = line.match(/^\s*/)[0].length;
    if (own === indent && /^\s*end\b/.test(line)) return r;
    if (own < indent && !line.trim().startsWith("#")) return null; // left the block without its `end`
  }
  return null;
}

// The innermost `@testset` containing `row`, from the text alone: { startRow, endRow } or null. Relies on the
// `end` being indented like its `@testset`, as formatted code is; the syntax tree (below) does not.
function findTestsetInText(lines, row) {
  for (let r = Math.min(row, lines.length - 1); r >= 0; r--) {
    const m = lines[r].match(TESTSET_LINE);
    if (!m) continue;
    const end = testsetEnd(lines, r, m[1].length);
    if (end !== null && end >= row) return { startRow: r, endRow: end };
  }
  return null;
}

// Is this syntax node a `@testset` call (`@testset ...` or `Test.@testset ...`)?
function isTestsetCall(node) {
  if (!node || node.type !== "macrocall_expression") return false;
  let head = node.firstChild;
  if (head && head.type === "field_expression") head = head.lastChild;
  return !!head && head.type === "macro_identifier" && head.text === "@testset";
}

// The innermost `@testset` call around `point` in a Tree-sitter tree (from the Julia grammar), as
// { startRow, endRow, start, end } with start/end as {row, column}, or null.
function findTestsetInTree(rootNode, point) {
  if (!rootNode) return null;
  let node = rootNode.descendantForPosition({ row: point.row, column: point.column });
  for (; node; node = node.parent) {
    if (!isTestsetCall(node)) continue;
    const start = { row: node.startPosition.row, column: node.startPosition.column };
    const end = { row: node.endPosition.row, column: node.endPosition.column };
    return { startRow: start.row, endRow: end.row, start, end };
  }
  return null;
}

// ----------------------------------------------------------------------------- setting up

// The environment to add for a test file: the nearest project above it when that is not a package itself, e.g. a
// package's `test/Project.toml` with its test-only dependencies. Null when the tests have no environment of their own
// (their dependencies are then in the package's `[extras]`, which only `Pkg.test` can provide).
function testEnvironmentFor(file, { exists = fs.existsSync, read } = {}) {
  if (!file) return null;
  const dir = findProjectDir(path.dirname(file), exists);
  if (!dir) return null;
  const project = readProject(dir, read ? { read } : undefined);
  return project && !project.name ? dir : null;
}

// The package a test file tests: the nearest package (a project with a name) at or above it.
function packageUnderTest(file, { exists = fs.existsSync, read } = {}) {
  if (!file) return null;
  let dir = path.dirname(file);
  for (;;) {
    const found = findProjectDir(dir, exists);
    if (!found) return null;
    const project = readProject(found, read ? { read } : undefined);
    if (project && project.name) return { name: project.name, dir: found };
    const parent = path.dirname(found);
    if (parent === found) return null;
    dir = parent;
  }
}

const JULIA_NAME = /^[\p{L}_][\p{L}\p{N}_!]*$/u;

// LOAD_PATH entries, added once. The package goes first, so that `using ThePackage` loads this checkout even when
// another version of it is in an environment earlier on LOAD_PATH (the shared `@v1.x` one, or the test environment
// the REPL was started in); Oscar's own `test_module` does the same. The test environment goes last: it only has to
// provide the test-only packages.
const addFirstToLoadPath = (dir) => `let env = ${rawString(dir)}; env in LOAD_PATH || pushfirst!(LOAD_PATH, env); end`;
const addLastToLoadPath = (dir) => `let env = ${rawString(dir)}; env in LOAD_PATH || push!(LOAD_PATH, env); end`;

// The lines of Julia code that prepare Main for a test file.
//   testEnv: the tests' own environment, or null
//   packageName, packageDir: the package to load with `using`, and its folder (Julia can load the package of any
//     project on LOAD_PATH), or null
//   setup: more code from the settings
function setupLines({ testEnv = null, packageName = null, packageDir = null, setup = "" } = {}) {
  const lines = [];
  const loadPackage = packageName && JULIA_NAME.test(packageName);
  if (loadPackage && packageDir) lines.push(addFirstToLoadPath(packageDir));
  if (testEnv) lines.push(addLastToLoadPath(testEnv));
  lines.push("using Test");
  if (loadPackage) lines.push(`using ${packageName}`);
  const extra = String(setup || "").trim();
  if (extra) lines.push(extra);
  return lines;
}

// Setup and tests go to the REPL as one piece of code, so that a failing setup (a package that does not load)
// stops there instead of running the tests into a cascade of "not defined" errors. The tests are evaluated with
// `include_string`, in Main, with their file name and line numbers (the code is padded with newlines to its first
// line) and with the file as the base for relative `include`s. The last line, `nothing;`, keeps the REPL from also
// printing the testset object after Test's own summary.
function testRunCode(setup, { code, file = "", line = 1 }) {
  const source = `"\\n"^${Math.max(0, line - 1)} * ${rawString(String(code).replace(/\s+$/, ""))}`;
  const name = rawString(file || "untitled");
  const run = file
    ? `task_local_storage(:SOURCE_PATH, ${name}) do
    include_string(Main, ${source}, ${name})
end`
    : `include_string(Main, ${source}, ${name})`;
  return [...setup, run, "nothing;"].join("\n");
}

function fileRunCode(setup, file) {
  return [...setup, `include(${rawString(file)})`, "nothing;"].join("\n");
}

// ----------------------------------------------------------------------------- JETLS's code actions

// The command of a code action or a bare command, or null.
function commandOf(action) {
  if (!action) return null;
  if (typeof action.command === "string") return action; // a Command
  if (action.command && typeof action.command.command === "string") return action.command; // a CodeAction
  return null;
}

// Which of JETLS's commands each editor command runs. `pick` chooses among several matches: the testset actions
// come outermost first, and the one wanted is the innermost.
const JETLS_ACTIONS = {
  "run-testset": {
    what: "a @testset",
    match: (c) => c.command === "jetls.testrunner.run@testset",
    pick: (list) => list[list.length - 1],
  },
  "run-test": {
    what: "a @test",
    match: (c) => c.command === "jetls.testrunner.run@test",
  },
  "show-macro-expansion": {
    what: "a macro call",
    match: (c) => c.command === "jetls.openMacroExpansion" && !/mode=toplevel/.test(String((c.arguments || [])[0])),
  },
  "expand-all-macros": {
    what: "code with macro calls",
    match: (c) => c.command === "jetls.openMacroExpansion" && /mode=toplevel/.test(String((c.arguments || [])[0])),
  },
  "show-inferred-types": {
    what: "code JETLS can annotate",
    match: (c) => c.command === "jetls.openTypeAnnotation",
  },
};

// The command to run for `name` among the server's code actions, or null.
function chooseCommand(name, actions) {
  const spec = JETLS_ACTIONS[name];
  if (!spec || !Array.isArray(actions)) return null;
  const matches = actions.map(commandOf).filter((c) => c && spec.match(c));
  if (matches.length === 0) return null;
  return spec.pick ? spec.pick(matches) : matches[0];
}

// ----------------------------------------------------------------------------- controller

// deps: setting(key), workspace, notifications, repl (ReplController),
//       connectionFor(editor) -> LanguageClientConnection | null, uriFor(path) -> uri,
//       exists/read (optional, for the project lookups)
class TestController {
  constructor(deps) {
    this.deps = deps;
  }

  notify(kind, message) { this.deps.notifications[kind](`Julia tests: ${message}`); }

  activeEditor() {
    const editor = this.deps.workspace.getActiveTextEditor();
    if (!editor) this.notify("addWarning", "open a Julia file first.");
    return editor;
  }

  lookups() {
    const out = {};
    if (this.deps.exists) out.exists = this.deps.exists;
    if (this.deps.read) out.read = this.deps.read;
    return out;
  }

  // The setup code for tests in `file`, following the settings, as lines.
  setupFor(file) {
    const useEnv = this.deps.setting("tests.environment") !== false;
    const loadPackage = this.deps.setting("tests.loadPackage") !== false;
    const pkg = file && loadPackage ? packageUnderTest(file, this.lookups()) : null;
    return setupLines({
      testEnv: file && useEnv ? testEnvironmentFor(file, this.lookups()) : null,
      packageName: pkg ? pkg.name : null,
      packageDir: pkg ? pkg.dir : null,
      setup: this.deps.setting("tests.setup") || "",
    });
  }

  // The testset around the cursor: from the Julia grammar's syntax tree when there is one, else from the text.
  testsetAt(editor) {
    const point = editor.getCursorBufferPosition();
    let tree = null;
    try {
      const mode = editor.getBuffer().getLanguageMode && editor.getBuffer().getLanguageMode();
      tree = mode && mode.rootLanguageLayer && mode.rootLanguageLayer.tree;
    } catch (e) { /* no tree: use the text */ }
    if (tree && tree.rootNode) {
      const found = findTestsetInTree(tree.rootNode, point);
      if (found) return found;
    }
    const lines = editor.getBuffer().getLines();
    const found = findTestsetInText(lines, point.row);
    if (!found) return null;
    return { ...found, start: { row: found.startRow, column: 0 }, end: { row: found.endRow, column: lines[found.endRow].length } };
  }

  async runTestsetInRepl() {
    const editor = this.activeEditor();
    if (!editor) return false;
    const testset = this.testsetAt(editor);
    if (!testset) {
      this.notify("addInfo", "put the cursor inside a @testset.");
      return false;
    }
    const file = editor.getPath() || "";
    const range = [[testset.start.row, testset.start.column], [testset.end.row, testset.end.column]];
    const repl = this.deps.repl;
    repl.flash(editor, range);
    const code = testRunCode(this.setupFor(file), { code: editor.getTextInBufferRange(range), file, line: testset.start.row + 1 });
    return repl.runInMain(code, { editor });
  }

  async runTestFileInRepl() {
    const editor = this.activeEditor();
    if (!editor) return false;
    const file = editor.getPath();
    if (!file) {
      this.notify("addWarning", "save the file first.");
      return false;
    }
    if (editor.isModified()) await editor.save();
    const repl = this.deps.repl;
    return repl.runInMain(fileRunCode(this.setupFor(file), file), { editor });
  }

  // Runs one of JETLS's code actions at the cursor (see JETLS_ACTIONS).
  async runJetlsAction(name) {
    const editor = this.activeEditor();
    if (!editor) return false;
    const spec = JETLS_ACTIONS[name];
    const file = editor.getPath();
    if (!file) {
      this.notify("addWarning", "save the file first, so JETLS knows it.");
      return false;
    }
    const connection = await this.deps.connectionFor(editor);
    if (!connection) {
      this.notify("addWarning", "JETLS is not running for this file yet.");
      return false;
    }
    const cursor = editor.getCursorBufferPosition();
    const position = { line: cursor.row, character: cursor.column };
    let actions;
    try {
      actions = await connection.codeAction({
        textDocument: { uri: this.deps.uriFor(file) },
        range: { start: position, end: position },
        context: { diagnostics: [] },
      });
    } catch (e) {
      this.notify("addError", `JETLS could not answer (${(e && e.message) || e}).`);
      return false;
    }
    const command = chooseCommand(name, actions);
    if (!command) {
      this.notify("addInfo", `put the cursor on ${spec.what}.`);
      return false;
    }
    try {
      await connection.executeCommand({ command: command.command, arguments: command.arguments || [] });
      return true;
    } catch (e) {
      this.notify("addError", `${command.title || command.command} failed: ${(e && e.message) || e}`);
      return false;
    }
  }

  commandTable() {
    return {
      "run-testset-in-repl": () => this.runTestsetInRepl(),
      "run-test-file-in-repl": () => this.runTestFileInRepl(),
      ...Object.fromEntries(Object.keys(JETLS_ACTIONS).map((name) => [name, () => this.runJetlsAction(name)])),
    };
  }
}

module.exports = {
  codePart, findTestsetInText, findTestsetInTree, isTestsetCall, testEnvironmentFor, packageUnderTest, setupLines,
  testRunCode, fileRunCode, commandOf, chooseCommand, JETLS_ACTIONS, TestController,
};
