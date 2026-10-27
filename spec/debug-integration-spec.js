// The debugger inside Pulsar: panes, gutter, current-line marker and keys, with the fake DAP adapter
// standing in for DebugAdapter.jl and the fake JETLS for the language server.
const path = require("path");
const { EventEmitter } = require("events");
const { setTimeout: realSetTimeout } = require("timers");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");
const { startFakeAdapter } = require("./helpers/fake-adapter");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const WORKSPACE_URI = "atom://pulsar-ide-julia/workspace";
const GUTTER = "pulsar-ide-julia-breakpoints";

// Mocked timers are in force in Pulsar specs, so poll with Node's real ones.
const waitUntil = async (predicate, what, ms = 8000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
};

describe("debugger", () => {
  let client, server, children;

  useTimeout(30000);

  const workspacePane = () => atom.workspace.getPaneItems().find((i) => i.getURI && i.getURI() === WORKSPACE_URI);
  const stopped = () => client.debug.session && client.debug.session.state.status === "stopped" && !client.debug.session.state.loading && client.debug.session.state.contexts.length > 0;

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
    server = await startFakeAdapter();
    children = [];
    client.debug.launch = async () => {
      const child = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });
      children.push(child);
      return { socket: await server.connect(), child };
    };
    atom.config.set("pulsar-ide-julia.debugStopOnEntry", true);
  }));

  afterEach(reportErrors(async () => {
    if (client && client.debug) await client.debug.stop();
    if (server) await server.close();
  }));

  it("registers its commands and keys", reportErrors(async () => {
    const names = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) }).map((c) => c.name);
    for (const c of ["debug-start-or-continue", "debug-file", "debug-continue", "debug-step-over", "debug-step-in", "debug-step-out", "debug-stop", "toggle-breakpoint", "clear-breakpoints", "open-workspace", "show-debug-output"]) {
      expect(names).toContain(`pulsar-ide-julia:${c}`);
    }
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    const bound = atom.keymaps.findKeyBindings({ target: atom.views.getView(editor) }).map((b) => `${b.keystrokes}=${b.command}`);
    expect(bound).toContain("f5=pulsar-ide-julia:debug-start-or-continue");
    expect(bound).toContain("f9=pulsar-ide-julia:toggle-breakpoint");
    expect(bound).toContain("f10=pulsar-ide-julia:debug-step-over");
  }));

  it("shows a breakpoint dot, keeps it on its line while editing, and removes it again", reportErrors(async () => {
    const file = path.join(fixtures, "cells.jl");
    const editor = await atom.workspace.open(file);
    expect(editor.gutterWithName(GUTTER)).toBeTruthy();
    const dots = () => editor.getDecorations({ type: "gutter", gutterName: GUTTER }).length;

    editor.setCursorBufferPosition([1, 0]);
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:toggle-breakpoint");
    expect(client.debug.store.list(file)).toEqual([{ line: 2, condition: "" }]);
    expect(dots()).toBe(1);

    editor.setTextInBufferRange([[0, 0], [0, 0]], "# a new first line\n");
    await waitUntil(() => client.debug.store.has(file, 3), "breakpoint to follow the text");
    expect(client.debug.store.list(file).map((b) => b.line)).toEqual([3]);
    expect(dots()).toBe(1);

    editor.setCursorBufferPosition([2, 0]);
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:toggle-breakpoint");
    expect(client.debug.store.list(file)).toEqual([]);
    expect(dots()).toBe(0);
    editor.undo();
  }));

  it("debugs a file: opens the workspace pane, marks the current line, lists variables", reportErrors(async () => {
    const file = path.join(fixtures, "cells.jl");
    const editor = await atom.workspace.open(file);
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:debug-file");
    await waitUntil(stopped, "the debugger to stop on entry");

    await waitUntil(() => workspacePane(), "the workspace pane");
    const pane = workspacePane();
    await waitUntil(() => pane.element.querySelectorAll(".row.variable").length >= 3, "variables in the pane");
    const names = [...pane.element.querySelectorAll(".row.variable .name")].map((n) => n.textContent);
    expect(names.slice(0, 3)).toEqual(["x", "v", "s"]);
    expect(pane.element.querySelector(".status").textContent).toMatch(/^Stopped \(entry\) in inner/);

    await waitUntil(() => editor.getDecorations({ type: "line", class: "pulsar-ide-julia-current-line" }).length === 1, "current line marker");
    expect(editor.getCursorBufferPosition().row).toBe(2);
  }));

  it("steps from the keyboard command and follows the new line", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:debug-file");
    await waitUntil(stopped, "stop on entry");
    atom.commands.dispatch(atom.views.getView(atom.workspace), "pulsar-ide-julia:debug-step-over");
    await waitUntil(() => stopped() && client.debug.session.state.frames[0].line === 4, "the step");
    await waitUntil(() => editor.getCursorBufferPosition().row === 3, "cursor to follow");
    const pane = workspacePane();
    await waitUntil(() => pane.element.querySelector(".row.variable .value").textContent === "1", "refreshed value");
  }));

  it("expands a variable with a click in the real DOM", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:debug-file");
    await waitUntil(stopped, "stop on entry");
    await waitUntil(() => workspacePane() && workspacePane().element.querySelectorAll(".row.variable").length >= 3, "rows");
    const pane = workspacePane();
    const v = [...pane.element.querySelectorAll(".row.variable")].find((r) => r.querySelector(".name").textContent === "v");
    v.click();
    await waitUntil(() => pane.element.querySelectorAll(".row.variable").length === 6, "children");
  }));

  it("removes the current-line marker when the session ends", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    atom.commands.dispatch(atom.views.getView(editor), "pulsar-ide-julia:debug-file");
    await waitUntil(stopped, "stop on entry");
    await waitUntil(() => editor.getDecorations({ type: "line", class: "pulsar-ide-julia-current-line" }).length === 1, "marker");
    atom.commands.dispatch(atom.views.getView(atom.workspace), "pulsar-ide-julia:debug-continue");
    await waitUntil(() => !client.debug.active, "the end");
    await waitUntil(() => editor.getDecorations({ type: "line", class: "pulsar-ide-julia-current-line" }).length === 0, "marker removal");
  }));
});
