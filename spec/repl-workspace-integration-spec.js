// The REPL feeding the Workspace pane inside Pulsar. A fake `terminal` service captures the command it is asked
// to run, and a socket client speaking julia/workspace.jl's protocol stands in for the Julia process. The pane is
// drawn by pulsar-ide-debugger; here we check what this package hands it through the debug-adapter service.
const fs = require("fs");
const net = require("net");
const path = require("path");
const { setTimeout: realSetTimeout } = require("timers");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");
const { FakeHelper } = require("./helpers/fake-repl-helper");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");

const waitUntil = async (predicate, what, ms = 8000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
};

describe("REPL variables for the Workspace pane", () => {
  let client, runs, socket, offered, subscription;

  useTimeout(30000);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
    runs = [];
    client.consumeTerminal({ open: () => Promise.resolve(), run: (cmds) => { runs.push(cmds); return Promise.resolve(true); } });
    atom.config.set("pulsar-ide-julia.repl.workspace", true);
    // What pulsar-ide-debugger would do with the service.
    offered = [];
    subscription = client.provideDebugAdapter().observeWorkspaceSource((source) => offered.push(source));
  }));

  afterEach(() => {
    if (subscription) subscription.dispose();
    if (socket) socket.destroy();
  });

  const current = () => offered[offered.length - 1] || null;

  it("starts the REPL with a startup file and shows what the REPL reports", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl(editor);

    const command = runs[0][0];
    const match = / -L (\S+)/.exec(command);
    expect(match).not.toBeNull();
    const startup = fs.readFileSync(match[1], "utf8");
    expect(startup).toContain("PulsarIDEWorkspace");

    // This is the Julia process connecting back.
    socket = net.connect(client.replBridge.address);
    new FakeHelper(socket);
    await waitUntil(current, "the REPL to be offered to the Workspace pane");
    expect(fs.existsSync(match[1])).toBe(false);

    const source = current();
    await waitUntil(() => source.state.contexts.length === 1 && source.state.contexts[0].items.length === 6, "variables from the REPL");
    expect(source.state.status).toBe("live");
    expect(source.state.contexts[0].name).toBe("Main");
    expect(source.state.contexts[0].items.map((i) => i.name)).toEqual(["x", "v", "C", "Foo", "f", "Base"]);
    expect(typeof source.refresh).toBe("function");
  }));

  it("lets the user pick the module, and remembers the choice in the settings", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl(editor);
    socket = net.connect(client.replBridge.address);
    const helper = new FakeHelper(socket);
    await waitUntil(current, "the REPL to be offered to the Workspace pane");
    const source = current();
    const choices = await source.choices();
    expect(choices.map((c) => c.label)).toEqual(["Follow editor", "Main", "Main.Base", "Main.Foo", "Main.Foo.Bar"]);

    source.choose("Main.Foo"); // what picking it in the pane's menu does
    await waitUntil(() => helper.requests.some((r) => r.op === "ls" && r.arg === "Main.Foo"), "the module switch");
    expect(atom.config.get("pulsar-ide-julia.repl.workspaceModule")).toBe("Main.Foo");
    atom.config.unset("pulsar-ide-julia.repl.workspaceModule");
  }));

  it("sends code to the module it is in, once the helper is connected", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "hello.jl"));
    await client.getConnectionForEditor(editor);
    // The REPL starts, and the helper (this fake) connects a little later; the first send waits for it.
    const opening = client.repl.openRepl(editor);
    await opening;
    socket = net.connect(client.replBridge.address);
    const helper = new FakeHelper(socket);
    editor.setCursorBufferPosition([0, 3]);
    await client.repl.sendSelectionOrDefinition();
    expect(runs.length).toBe(1); // nothing but the start of Julia was typed
    expect(helper.evals).toEqual([1]);
    const request = fs.readFileSync(path.join(client.replBridge.evalDir, "1.jl"), "utf8").split("\n");
    // module, file, line, package (none: the fixture is not in a package), then the code
    expect(request.slice(0, 4)).toEqual(["Main", editor.getPath(), "1", ""]);
    expect(request.slice(4).join("\n")).toBe('greet(name::String) = "Hello, $name!"');
  }));

  it("leaves the command alone when the setting is off", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.repl.workspace", false);
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl(editor);
    expect(runs[0][0]).not.toContain(" -L ");
  }));
});
