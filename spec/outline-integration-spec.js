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

  it("shows the signature read from the definition line", reportErrors(async () => {
    const outline = await client.getOutline(editor);
    const tree = outline && outline.outlineTrees && outline.outlineTrees[0];
    if (!tree || tree.plainText !== "greet(name::String)") fail(`unexpected outline: ${JSON.stringify(outline)}`);
    expect(tree && tree.plainText).toBe("greet(name::String)");
  }));

  it("shows just the name when the setting is off", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.outlineSignatures", false);
    const outline = await client.getOutline(editor);
    const tree = outline.outlineTrees[0];
    expect(tree.plainText === undefined || !tree.plainText.includes("(")).toBe(true);
  }));
});
