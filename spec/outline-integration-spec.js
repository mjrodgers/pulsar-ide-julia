// getOutline() against the fake server, which reports one symbol `greet` on line 0 of
// fixtures/hello.jl:  greet(name::String) = "Hello, $name!"
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("outline signatures", () => {
  let client, editor;

  useTimeout(SLOW);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
    editor = await atom.workspace.open(path.join(fixtures, "hello.jl"));
    await client.getConnectionForEditor(editor); // resolves once the server has initialized
  }));

  const labels = (trees) => trees.map((t) => [t.plainText, ...labels(t.children)]).flat();

  it("labels functions with the signature JETLS sends and hides arguments and locals", reportErrors(async () => {
    const outline = await client.getOutline(editor);
    expect(labels(outline.outlineTrees)).toEqual(["greet(name::String)"]);
    expect(outline.outlineTrees[0].startPosition.row).toBe(0);
  }));

  it("lists arguments, locals and blocks when asked to", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.outline.locals", true);
    const outline = await client.getOutline(editor);
    expect(labels(outline.outlineTrees)).toEqual(["greet(name::String)", "for x in y", "x", "name", "msg"]);
  }));

  it("gives Go to Symbol the same symbols, with the argument list as context", reportErrors(async () => {
    const provider = client.provideSymbols();
    const listController = { set() {}, clear() {} };
    const symbols = await provider.getSymbols({ type: "file", editor }, listController);
    expect(symbols.map((s) => [s.name, s.context, s.tag])).toEqual([["greet", "(name::String)", "function"]]);
    expect(symbols[0].position.row).toBe(0);
  }));

  it("shows plain names when signatures are off", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.outline.signatures", false);
    const outline = await client.getOutline(editor);
    expect(labels(outline.outlineTrees)).toEqual(["greet"]);
  }));
});
