// The REPL commands inside Pulsar, with a fake `terminal` service and the fake JETLS.
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");

describe("terminal REPL", () => {
  let client, service, runs, opened;

  useTimeout(20000);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
    runs = [];
    opened = 0;
    service = { open: () => { opened++; return Promise.resolve(); }, run: (cmds) => { runs.push(cmds); return Promise.resolve(true); } };
    client.consumeTerminal(service);
  }));

  it("registers its commands", () => {
    const names = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) }).map((c) => c.name);
    for (const c of ["open-repl", "send-selection-or-definition", "send-cell", "send-cell-and-advance", "send-file", "activate-environment", "next-cell", "previous-cell",
      "send-selection-or-definition-and-advance", "activate-environment-in-current-folder", "activate-environment-in-parent-folder",
      "activate-default-environment", "select-environment", "work-in-current-folder", "work-in-project-folder", "work-in-home-folder",
      "select-working-folder"]) {
      expect(names).toContain(`pulsar-ide-julia:${c}`);
    }
  });

  it("binds the Juno-style keys in Julia files", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    const bound = atom.keymaps.findKeyBindings({ target: atom.views.getView(editor) }).map((b) => b.command);
    expect(bound).toContain("pulsar-ide-julia:send-selection-or-definition");
    expect(bound).toContain("pulsar-ide-julia:send-cell");
    expect(bound).toContain("pulsar-ide-julia:send-selection-or-definition-and-advance");
  }));

  it("starts Julia in a new terminal", reportErrors(async () => {
    await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl();
    expect(opened).toBe(1);
    expect(runs[0][0]).toMatch(/^julia/);
  }));

  it("sends the cell around the cursor", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    editor.setCursorBufferPosition([6, 0]);
    await client.repl.sendCell();
    expect(runs[runs.length - 1]).toEqual(["## second cell", "function f(a)", "    a + 1", "end"]);
  }));

  it("sends the definition JETLS reports for the cursor", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "hello.jl"));
    await client.getConnectionForEditor(editor);
    editor.setCursorBufferPosition([0, 3]);
    await client.repl.sendSelectionOrDefinition();
    expect(runs[runs.length - 1]).toEqual(['greet(name::String) = "Hello, $name!"']);
  }));

  it("moves between cells", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    editor.setCursorBufferPosition([1, 0]);
    client.repl.moveToCell(1);
    expect(editor.getCursorBufferPosition().row).toBe(4);
  }));
});
