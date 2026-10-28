const { EventEmitter } = require("events");
// Node's own timers: Pulsar's spec runner replaces the global setTimeout with a mock clock.
const { setTimeout } = require("timers");
const { enclosingModulePath, chooseExistingModule, candidateFor, ModuleFollower, FOLLOW } = require("../lib/workspace/module-follow");

const range = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const mod = (name, r, children = []) => ({ name, kind: 2, range: r, selectionRange: r, children });
const fn = (name, r) => ({ name, kind: 12, range: r, selectionRange: r, children: [] });

// module Outer (0-19)
//   module Inner (2-9)
//     f (3-5)
//   end
//   g (11-13)
// end
// module Second (21-25)
const symbols = [
  mod("Outer", range(0, 0, 19, 3), [
    mod("Inner", range(2, 2, 9, 5), [fn("f", range(3, 4, 5, 7))]),
    fn("g", range(11, 2, 13, 5)),
  ]),
  mod("Second", range(21, 0, 25, 3)),
];

describe("enclosingModulePath", () => {
  it("is empty outside every module", () => {
    expect(enclosingModulePath(symbols, 20, 0)).toEqual([]);
    expect(enclosingModulePath(symbols, 30, 0)).toEqual([]);
  });
  it("finds the module and the nested one", () => {
    expect(enclosingModulePath(symbols, 1, 0)).toEqual(["Outer"]);
    expect(enclosingModulePath(symbols, 11, 3)).toEqual(["Outer"]);
    expect(enclosingModulePath(symbols, 4, 5)).toEqual(["Outer", "Inner"]);
    expect(enclosingModulePath(symbols, 22, 1)).toEqual(["Second"]);
  });
  it("includes the range boundaries", () => {
    expect(enclosingModulePath(symbols, 2, 2)).toEqual(["Outer", "Inner"]);
    expect(enclosingModulePath(symbols, 9, 5)).toEqual(["Outer", "Inner"]);
    expect(enclosingModulePath(symbols, 2, 1)).toEqual(["Outer"]);
  });
  it("treats code that starts where a module starts as the module itself (strict)", () => {
    const strict = { strict: true };
    expect(enclosingModulePath(symbols, 0, 0, strict)).toEqual([]);
    expect(enclosingModulePath(symbols, 2, 2, strict)).toEqual(["Outer"]);
    expect(enclosingModulePath(symbols, 3, 4, strict)).toEqual(["Outer", "Inner"]);
    expect(enclosingModulePath(symbols, 9, 5, strict)).toEqual(["Outer", "Inner"]);
    expect(enclosingModulePath(symbols, 21, 0, strict)).toEqual([]);
  });
  it("copes with odd replies", () => {
    expect(enclosingModulePath(null, 1, 1)).toEqual([]);
    expect(enclosingModulePath([{ name: "x", kind: 2 }], 1, 1)).toEqual([]); // no range (flat SymbolInformation)
    expect(enclosingModulePath([mod("A", range(0, 0, 5, 0))], 1, 1)).toEqual(["A"]);
  });
});

describe("chooseExistingModule", () => {
  const names = ["Main", "Main.Outer", "Main.Base", "Main.Second"];
  it("takes the deepest module the REPL knows", () => {
    expect(chooseExistingModule(names, ["Outer"])).toBe("Main.Outer");
    expect(chooseExistingModule(names, ["Outer", "Inner"])).toBe("Main.Outer");
    expect(chooseExistingModule([...names, "Main.Outer.Inner"], ["Outer", "Inner"])).toBe("Main.Outer.Inner");
  });
  it("falls back to Main", () => {
    expect(chooseExistingModule(names, [])).toBe("Main");
    expect(chooseExistingModule(names, ["Unknown"])).toBe("Main");
    expect(chooseExistingModule([], ["Outer"])).toBe("Main");
  });
  it("spells a path", () => {
    expect(candidateFor([])).toBe("Main");
    expect(candidateFor(["A", "B"])).toBe("Main.A.B");
  });
});

// A minimal editor and workspace for the follower.
function fakeEditor(grammar = "source.julia") {
  const e = new EventEmitter();
  e.position = { row: 0, column: 0 };
  e.getGrammar = () => ({ scopeName: grammar });
  e.getCursorBufferPosition = () => e.position;
  e.onDidChangeCursorPosition = (fn2) => { e.on("cursor", fn2); return { dispose: () => e.removeListener("cursor", fn2) }; };
  e.onDidStopChanging = (fn2) => { e.on("stop", fn2); return { dispose: () => e.removeListener("stop", fn2) }; };
  e.moveTo = (row, column) => { e.position = { row, column }; e.emit("cursor"); };
  return e;
}
const fakeWorkspace = () => {
  const w = new EventEmitter();
  w.observeActiveTextEditor = (fn2) => { w.on("active", fn2); return { dispose: () => w.removeListener("active", fn2) }; };
  w.activate = (editor) => w.emit("active", editor);
  return w;
};
const until = async (predicate, what, ms = 2000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

describe("ModuleFollower", () => {
  let workspace, editor, follower, paths, fetches, active;
  beforeEach(() => {
    workspace = fakeWorkspace();
    editor = fakeEditor();
    paths = [];
    fetches = 0;
    active = true;
    follower = new ModuleFollower({
      workspace,
      fetchSymbols: async () => { fetches++; return symbols; },
      onPath: (p) => paths.push(p),
      isActive: () => active,
      delay: 5,
    });
    follower.start();
  });
  afterEach(() => follower.dispose());

  it("reports the module at the cursor when an editor becomes active", async () => {
    editor.position = { row: 4, column: 5 };
    workspace.activate(editor);
    await until(() => paths.length === 1, "first report");
    expect(paths[0]).toEqual(["Outer", "Inner"]);
  });

  it("follows the cursor, fetching the symbols only once", async () => {
    workspace.activate(editor);
    await until(() => paths.length === 1, "first report");
    editor.moveTo(22, 0);
    await until(() => paths.length === 2, "second report");
    expect(paths[1]).toEqual(["Second"]);
    expect(fetches).toBe(1);
  });

  it("fetches again after the text changed", async () => {
    workspace.activate(editor);
    await until(() => paths.length === 1, "first report");
    editor.emit("stop");
    await until(() => paths.length === 2, "report after edit");
    expect(fetches).toBe(2);
  });

  it("does nothing for other languages or when following is off", async () => {
    workspace.activate(fakeEditor("source.js"));
    await new Promise((r) => setTimeout(r, 30));
    expect(paths).toEqual([]);
    active = false;
    workspace.activate(editor);
    await new Promise((r) => setTimeout(r, 30));
    expect(paths).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("survives a server that is not ready", async () => {
    follower.fetchSymbols = async () => { throw new Error("no connection"); };
    workspace.activate(editor);
    await new Promise((r) => setTimeout(r, 30));
    expect(paths).toEqual([]);
  });

  it("stops listening to an editor that is no longer active", async () => {
    workspace.activate(editor);
    await until(() => paths.length === 1, "first report");
    workspace.activate(null);
    const count = paths.length;
    editor.moveTo(22, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(paths.length).toBe(count);
  });

  it("looks again when the model starts following", async () => {
    workspace.activate(editor);
    await until(() => paths.length === 1, "first report");
    const model = Object.assign(new EventEmitter(), { following: false, onDidChange(fn2) { this.on("c", fn2); return () => this.removeListener("c", fn2); } });
    follower.watchModel(model);
    model.following = true;
    model.emit("c");
    await until(() => paths.length === 2, "report after switching on");
  });

  it("exposes the special choice", () => {
    expect(FOLLOW).toBe("@follow");
  });
});
