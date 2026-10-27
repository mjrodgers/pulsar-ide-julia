// The REPL feeding the workspace pane inside Pulsar. A fake `terminal` service captures the command it is asked
// to run, and a socket client speaking julia/workspace.jl's protocol stands in for the Julia process.
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
const WORKSPACE_URI = "atom://pulsar-ide-julia/workspace";

const waitUntil = async (predicate, what, ms = 8000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => realSetTimeout(r, 10));
  }
};

describe("REPL variables in the workspace pane", () => {
  let client, runs, socket;

  useTimeout(30000);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
    runs = [];
    client.consumeTerminal({ open: () => Promise.resolve(), run: (cmds) => { runs.push(cmds); return Promise.resolve(true); } });
    atom.config.set("pulsar-ide-julia.replWorkspace", true);
  }));

  afterEach(() => {
    if (socket) socket.destroy();
    for (const item of atom.workspace.getPaneItems()) {
      try { if (item.getURI && item.getURI() === WORKSPACE_URI) item.destroy(); } catch (e) { /* ignore */ }
    }
  });

  const workspacePane = () => atom.workspace.getPaneItems().find((i) => i.getURI && i.getURI() === WORKSPACE_URI);

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
    await waitUntil(() => client.debug.model.session, "the pane to follow the REPL");
    expect(fs.existsSync(match[1])).toBe(false);

    await client.debug.ui.openWorkspace();
    await waitUntil(workspacePane, "the workspace pane");
    const pane = workspacePane();
    await waitUntil(() => pane.element.querySelectorAll(".row.variable").length === 6, "variables from the REPL");
    expect(pane.element.querySelector(".status").textContent).toBe("REPL: Main");
    expect([...pane.element.querySelectorAll(".row.variable .name")].map((n) => n.textContent)).toEqual(["x", "v", "C", "Foo", "f", "Base"]);
    expect(pane.element.querySelector("button.refresh").classList.contains("hidden")).toBe(false);
  }));

  it("lets the user pick the module, and remembers the choice in the settings", reportErrors(async () => {
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl(editor);
    socket = net.connect(client.replBridge.address);
    const helper = new FakeHelper(socket);
    await waitUntil(() => client.debug.model.session, "the pane to follow the REPL");
    await client.debug.ui.openWorkspace();
    await waitUntil(workspacePane, "the workspace pane");
    const pane = workspacePane();
    await waitUntil(() => client.debug.model.moduleNames.length > 0, "the module list");

    const select = pane.element.querySelector("select.modules");
    expect(select.classList.contains("hidden")).toBe(false);
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Follow editor", "Main", "Main.Base", "Main.Foo", "Main.Foo.Bar"]);

    select.value = "Main.Foo";
    select.dispatchEvent(new Event("change"));
    await waitUntil(() => helper.requests.some((r) => r.op === "ls" && r.arg === "Main.Foo"), "the module switch");
    expect(atom.config.get("pulsar-ide-julia.workspaceModule")).toBe("Main.Foo");
    atom.config.unset("pulsar-ide-julia.workspaceModule");
  }));

  it("leaves the command alone when the setting is off", reportErrors(async () => {
    atom.config.set("pulsar-ide-julia.replWorkspace", false);
    const editor = await atom.workspace.open(path.join(fixtures, "cells.jl"));
    await client.repl.openRepl(editor);
    expect(runs[0][0]).not.toContain(" -L ");
  }));
});
