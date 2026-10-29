// Running tests (lib/tests.js), with fakes for the editor, the REPL and JETLS (no Pulsar needed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  codePart, findTestsetInText, findTestsetInTree, testEnvironmentFor, packageUnderTest, setupLines, testRunCode,
  fileRunCode, chooseCommand, TestController,
} = require("../lib/tests");

const lines = (text) => text.split("\n");

describe("finding the @testset around the cursor in the text", () => {
  const text = lines([
    'using Test',                          // 0
    '@testset "outer" begin',              // 1
    '    x = 1',                           // 2
    '    @testset "inner for loops" begin', // 3
    '        @test x == 1',                // 4
    '    end # inner',                     // 5
    '    @testset "one line" check(x)',    // 6
    '    @testset "loop" for i in 1:3',    // 7
    '        @test i > 0',                 // 8
    '    end',                             // 9
    'end',                                 // 10
    '@test true',                          // 11
  ].join("\n"));

  it("finds the innermost one", () => {
    expect(findTestsetInText(text, 4)).toEqual({ startRow: 3, endRow: 5 });
    expect(findTestsetInText(text, 8)).toEqual({ startRow: 7, endRow: 9 });
    expect(findTestsetInText(text, 6)).toEqual({ startRow: 6, endRow: 6 });
  });

  it("finds the outer one between and around inner ones", () => {
    expect(findTestsetInText(text, 2)).toEqual({ startRow: 1, endRow: 10 });
    expect(findTestsetInText(text, 10)).toEqual({ startRow: 1, endRow: 10 });
  });

  it("finds none outside testsets", () => {
    expect(findTestsetInText(text, 0)).toBe(null);
    expect(findTestsetInText(text, 11)).toBe(null);
  });

  it("is not fooled by words in strings and comments, or by assignment and qualified forms", () => {
    expect(codePart('@testset "for loops" f() # begin')).toBe('@testset "" f() ');
    expect(findTestsetInText(lines('@testset "for loops" f()'), 0)).toEqual({ startRow: 0, endRow: 0 });
    expect(findTestsetInText(lines('ts = Test.@testset "t" begin\n  @test true\nend'), 1)).toEqual({ startRow: 0, endRow: 2 });
    expect(findTestsetInText(lines('@testset "t" begin @test true end'), 0)).toEqual({ startRow: 0, endRow: 0 });
  });
});

describe("finding the @testset around the cursor in the syntax tree", () => {
  // Just enough of a Tree-sitter node.
  const node = (type, start, end, children = [], text = "") => {
    const n = { type, startPosition: start, endPosition: end, children, text, parent: null };
    for (const c of children) c.parent = n;
    n.firstChild = children[0] || null;
    n.lastChild = children[children.length - 1] || null;
    return n;
  };
  const at = (row, column) => ({ row, column });
  const macro = (name, row) => node("macro_identifier", at(row, 0), at(row, name.length), [], name);

  it("returns the innermost @testset call, with its exact range", () => {
    const test = node("macrocall_expression", at(2, 4), at(2, 16), [macro("@test", 2)]);
    const inner = node("macrocall_expression", at(1, 2), at(3, 5), [macro("@testset", 1), node("compound_statement", at(1, 14), at(3, 5), [test])]);
    const outer = node("macrocall_expression", at(0, 0), at(4, 3), [macro("@testset", 0), node("compound_statement", at(0, 13), at(4, 3), [inner])]);
    const root = node("source_file", at(0, 0), at(5, 0), [outer]);
    root.descendantForPosition = () => test;
    expect(findTestsetInTree(root, at(2, 6))).toEqual({ startRow: 1, endRow: 3, start: at(1, 2), end: at(3, 5) });
  });

  it("returns null outside testsets or without a tree", () => {
    const call = node("call_expression", at(0, 0), at(0, 3));
    const root = node("source_file", at(0, 0), at(1, 0), [call]);
    root.descendantForPosition = () => call;
    expect(findTestsetInTree(root, at(0, 1))).toBe(null);
    expect(findTestsetInTree(null, at(0, 0))).toBe(null);
  });
});

describe("the test environment and the package being tested", () => {
  let root;
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tests-env-"));
    write("Pkg/Project.toml", 'name = "MyPkg"\nuuid = "12345678-1234-1234-1234-123456789abc"\n');
    write("Pkg/test/Project.toml", '[deps]\nTest = "8dfed614-e22c-5e08-85e1-65c5234f0b40"\n');
    write("Old/Project.toml", 'name = "OldPkg"\n\n[extras]\nTest = "8dfed614-e22c-5e08-85e1-65c5234f0b40"\n');
    write("Old/test/runtests.jl", "");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("uses test/Project.toml when the tests have one, and tests the package above it", () => {
    const file = path.join(root, "Pkg", "test", "Groups", "gsets.jl");
    expect(testEnvironmentFor(file)).toBe(path.join(root, "Pkg", "test"));
    expect(packageUnderTest(file)).toEqual({ name: "MyPkg", dir: path.join(root, "Pkg") });
  });

  it("has no separate environment when the test dependencies are the package's [extras]", () => {
    const file = path.join(root, "Old", "test", "runtests.jl");
    expect(testEnvironmentFor(file)).toBe(null);
    expect(packageUnderTest(file).name).toBe("OldPkg");
  });

  it("finds nothing outside a project", () => {
    expect(testEnvironmentFor(path.join(os.tmpdir(), "nowhere-xyz", "a.jl"))).toBe(null);
    expect(testEnvironmentFor(null)).toBe(null);
    expect(packageUnderTest(null)).toBe(null);
  });
});

describe("the setup and test code", () => {
  it("puts the package first on LOAD_PATH and the test environment last, then loads Test, the package and the extra setup", () => {
    expect(setupLines({ testEnv: "/p/test", packageName: "MyPkg", packageDir: "/p", setup: "using Aqua" })).toEqual([
      'let env = raw"/p"; env in LOAD_PATH || pushfirst!(LOAD_PATH, env); end',
      'let env = raw"/p/test"; env in LOAD_PATH || push!(LOAD_PATH, env); end',
      "using Test",
      "using MyPkg",
      "using Aqua",
    ]);
    expect(setupLines()).toEqual(["using Test"]);
  });

  it("refuses package names that are not Julia names", () => {
    expect(setupLines({ packageName: "x; rm()" })).toEqual(["using Test"]);
  });

  it("runs setup and testset as one piece, the testset with its file, line and include base", () => {
    expect(testRunCode(["using Test"], { code: '@testset "t" begin\n  @test "q\\"" == "q\\""\nend\n\n', file: "/p/a.jl", line: 4 }).split("\n")).toEqual([
      "using Test",
      'task_local_storage(:SOURCE_PATH, raw"/p/a.jl") do',
      '    include_string(Main, "\\n"^3 * raw"@testset \\"t\\" begin',
      '  @test \\"q\\\\\\"\\" == \\"q\\\\\\"\\"',
      'end", raw"/p/a.jl")',
      "end",
      "nothing;",
    ]);
  });

  it("names unsaved code and includes whole files", () => {
    expect(testRunCode([], { code: "@test true" })).toBe('include_string(Main, "\\n"^0 * raw"@test true", raw"untitled")\nnothing;');
    expect(fileRunCode(["using Test"], "/p/a.jl")).toBe('using Test\ninclude(raw"/p/a.jl")\nnothing;');
  });
});

describe("choosing among JETLS's code actions", () => {
  const action = (command, args = [], title = command) => ({ title, command: { title, command, arguments: args } });
  const actions = [
    action("jetls.testrunner.run@testset", ["u", 1, '"outer"']),
    action("jetls.testrunner.run@testset", ["u", 2, '"inner"']),
    action("jetls.testrunner.run@test", ["u", 5, "@test x"]),
    action("jetls.openMacroExpansion", ["jetls-macro-expansion:/macro-expanded.jl?source=u&start=1&stop=9"]),
    action("jetls.openMacroExpansion", ["jetls-macro-expansion:/macro-expanded.jl?source=u&start=1&stop=90&mode=toplevel"]),
    action("jetls.openTypeAnnotation", ["jetls-type-annotation:/x"]),
    { title: "Insert explicit return", edit: {} },
  ];

  it("picks the innermost testset, and each kind of view", () => {
    expect(chooseCommand("run-testset", actions).arguments[2]).toBe('"inner"');
    expect(chooseCommand("run-test", actions).arguments[1]).toBe(5);
    expect(chooseCommand("show-macro-expansion", actions).arguments[0]).not.toContain("toplevel");
    expect(chooseCommand("expand-all-macros", actions).arguments[0]).toContain("mode=toplevel");
    expect(chooseCommand("show-inferred-types", actions).command).toBe("jetls.openTypeAnnotation");
  });

  it("accepts bare commands and copes with no actions", () => {
    expect(chooseCommand("run-test", [{ title: "t", command: "jetls.testrunner.run@test", arguments: [] }]).command).toBe("jetls.testrunner.run@test");
    expect(chooseCommand("run-test", null)).toBe(null);
    expect(chooseCommand("run-test", [])).toBe(null);
    expect(chooseCommand("no-such-thing", actions)).toBe(null);
  });
});

describe("TestController", () => {
  function fakeEditor({ text, filePath = "/p/test/a_test.jl", cursor = [0, 0], tree = null, modified = false }) {
    const ls = lines(text);
    const ed = {
      saved: false,
      getPath: () => filePath,
      isModified: () => modified,
      save: async () => { ed.saved = true; },
      getCursorBufferPosition: () => ({ row: cursor[0], column: cursor[1] }),
      getBuffer: () => ({ getLines: () => ls, getLanguageMode: () => (tree ? { rootLanguageLayer: { tree } } : {}) }),
      getTextInBufferRange: ([[r1, c1], [r2, c2]]) =>
        (r1 === r2 ? ls[r1].slice(c1, c2) : [ls[r1].slice(c1), ...ls.slice(r1 + 1, r2), ls[r2].slice(0, c2)].join("\n")),
    };
    return ed;
  }

  function setup({ editor, settings = {}, connection = null, read = null } = {}) {
    const log = { notes: [], ran: [], flashed: [] };
    const values = { "tests.environment": true, "tests.loadPackage": true, "tests.setup": "", ...settings };
    const repl = {
      flash: (ed, range) => log.flashed.push(range),
      runInMain: async (code, options) => { log.ran.push([code, options.file || "", options.line || 1]); return true; },
    };
    const controller = new TestController({
      setting: (k) => values[k],
      workspace: { getActiveTextEditor: () => editor },
      notifications: new Proxy({}, { get: (_, kind) => (msg) => log.notes.push([kind, msg]) }),
      repl,
      connectionFor: async () => connection,
      uriFor: (file) => `file://${file}`,
      // a package /p with its test environment /p/test
      exists: (f) => f === "/p/Project.toml" || f === "/p/test/Project.toml",
      read: read || ((f) => {
        if (f === "/p/Project.toml") return 'name = "MyPkg"\n';
        if (f === "/p/test/Project.toml") return "[deps]\n";
        throw new Error(`no ${f}`);
      }),
    });
    return { controller, log };
  }

  const testFile = ['@testset "a" begin', "    @test 1 == 1", "end", '@testset "b" begin', "    @test f() == 2", "end"].join("\n");

  it("runs the setup, then the testset at the cursor with its file and line", async () => {
    const editor = fakeEditor({ text: testFile, cursor: [4, 4] });
    const { controller, log } = setup({ editor });
    expect(await controller.runTestsetInRepl()).toBe(true);
    expect(log.ran.length).toBe(1);
    const [code] = log.ran[0];
    expect(code).toContain("pushfirst!(LOAD_PATH, env)");
    expect(code).toContain("using Test\nusing MyPkg\n");
    expect(code).toContain('include_string(Main, "\\n"^3 * raw"@testset \\"b\\" begin\n    @test f() == 2\nend", raw"/p/test/a_test.jl")');
    expect(log.flashed).toEqual([[[3, 0], [5, 3]]]);
  });

  it("follows the settings for the environment, the package and extra setup", async () => {
    const editor = fakeEditor({ text: testFile, cursor: [1, 0] });
    const { controller, log } = setup({ editor, settings: { "tests.environment": false, "tests.loadPackage": false, "tests.setup": "using Aqua" } });
    await controller.runTestsetInRepl();
    expect(log.ran[0][0].split("\n").slice(0, 3)).toEqual(["using Test", "using Aqua", 'task_local_storage(:SOURCE_PATH, raw"/p/test/a_test.jl") do']);
  });

  it("uses the syntax tree when the grammar provides one", async () => {
    const at = (row, column) => ({ row, column });
    const macroId = { type: "macro_identifier", text: "@testset", firstChild: null, lastChild: null };
    const call = { type: "macrocall_expression", startPosition: at(0, 0), endPosition: at(2, 3), firstChild: macroId, parent: null };
    const tree = { rootNode: { descendantForPosition: () => call } };
    const editor = fakeEditor({ text: testFile, cursor: [1, 4], tree });
    const { controller, log } = setup({ editor });
    await controller.runTestsetInRepl();
    expect(log.ran[0][0]).toContain('"\\n"^0 * raw"@testset \\"a\\" begin\n    @test 1 == 1\nend"');
  });

  it("explains when the cursor is not in a testset", async () => {
    const editor = fakeEditor({ text: "x = 1\n" + testFile, cursor: [0, 0] });
    const { controller, log } = setup({ editor });
    expect(await controller.runTestsetInRepl()).toBe(false);
    expect(log.ran.length).toBe(0);
    expect(log.notes[0][1]).toContain("@testset");
  });

  it("runs a whole test file after the setup, saving it first", async () => {
    const editor = fakeEditor({ text: testFile, modified: true });
    const { controller, log } = setup({ editor });
    await controller.runTestFileInRepl();
    expect(editor.saved).toBe(true);
    expect(log.ran[0][0]).toMatch(/using MyPkg\ninclude\(raw"\/p\/test\/a_test.jl"\)\nnothing;$/);
  });

  describe("JETLS's actions", () => {
    const connectionWith = (actions, calls) => ({
      codeAction: async (params) => { calls.push(["codeAction", params]); return actions; },
      executeCommand: async (params) => { calls.push(["executeCommand", params]); return null; },
    });

    it("asks for the code actions at the cursor and runs the matching command", async () => {
      const calls = [];
      const connection = connectionWith([
        { title: "Run outer", command: { title: "Run outer", command: "jetls.testrunner.run@testset", arguments: ["u", 1, "outer"] } },
        { title: "Run inner", command: { title: "Run inner", command: "jetls.testrunner.run@testset", arguments: ["u", 2, "inner"] } },
      ], calls);
      const editor = fakeEditor({ text: testFile, cursor: [4, 6] });
      const { controller } = setup({ editor, connection });
      expect(await controller.runJetlsAction("run-testset")).toBe(true);
      expect(calls[0]).toEqual(["codeAction", {
        textDocument: { uri: "file:///p/test/a_test.jl" },
        range: { start: { line: 4, character: 6 }, end: { line: 4, character: 6 } },
        context: { diagnostics: [] },
      }]);
      expect(calls[1]).toEqual(["executeCommand", { command: "jetls.testrunner.run@testset", arguments: ["u", 2, "inner"] }]);
    });

    it("says what to put the cursor on when JETLS offers nothing", async () => {
      const calls = [];
      const editor = fakeEditor({ text: testFile });
      const { controller, log } = setup({ editor, connection: connectionWith([], calls) });
      expect(await controller.runJetlsAction("show-macro-expansion")).toBe(false);
      expect(log.notes[0][1]).toContain("macro call");
      expect(calls.length).toBe(1);
    });

    it("needs a saved file and a running server", async () => {
      const unsaved = setup({ editor: fakeEditor({ text: testFile, filePath: null }) });
      expect(await unsaved.controller.runJetlsAction("run-test")).toBe(false);
      expect(unsaved.log.notes[0][1]).toContain("save");
      const noServer = setup({ editor: fakeEditor({ text: testFile }), connection: null });
      expect(await noServer.controller.runJetlsAction("run-test")).toBe(false);
      expect(noServer.log.notes[0][1]).toContain("not running");
    });
  });
});
