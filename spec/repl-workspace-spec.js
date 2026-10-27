const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { startFakeHelper } = require("./helpers/fake-repl-helper");
const { fakeDocument } = require("./helpers/fake-dom");
const { ReplWorkspaceSource } = require("../lib/workspace/repl-source");
const { ReplBridge, bootstrapSource } = require("../lib/workspace/repl-bridge");
const { WorkspaceModel, pathOf } = require("../lib/workspace/model");
const { FOLLOW } = require("../lib/workspace/module-follow");
const { WorkspacePane } = require("../lib/workspace/pane");
const { DebugController } = require("../lib/debug/controller");

const until = async (predicate, what = "condition", ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

describe("ReplWorkspaceSource (against a fake helper)", () => {
  let server, source;

  const open = async (options = {}, sourceOptions = {}) => {
    server = await startFakeHelper(options);
    source = new ReplWorkspaceSource(await server.connect(), { refreshDelay: 10, ...sourceOptions });
    await until(() => server.helper, "helper connection");
  };
  const names = () => source.state.contexts[0].items.map((i) => i.name);

  afterEach(async () => {
    if (source) source.close();
    if (server) await server.close();
    source = server = undefined;
  });

  it("lists the module on connect", async () => {
    await open();
    await until(() => source.state.contexts.length === 1, "first listing");
    const [ctx] = source.state.contexts;
    expect(ctx.name).toBe("Main");
    expect(ctx.lazy).toBe(false);
    expect(names()).toEqual(["x", "v", "C", "Foo", "f", "Base"]);
    expect(ctx.items[0]).toEqual({ name: "x", value: "42", type: "Int64", ref: 0, kind: "variable", truncated: false });
    expect(ctx.items[1].ref).toBeGreaterThan(0);
    expect(source.state.status).toBe("live");
    expect(server.helper.requests[0]).toEqual({ id: 1, op: "ls", arg: "Main" });
  });

  it("loads children by ref", async () => {
    await open();
    await until(() => source.state.contexts.length === 1);
    const kids = await source.loadVariables(source.state.contexts[0].items[1].ref);
    expect(kids.map((k) => [k.name, k.value])).toEqual([["[1]", "1"], ["[2]", "2"], ["[3]", "3"]]);
    expect(await source.loadVariables(0)).toEqual([]);
  });

  it("rejects with the helper's message for an out-of-date value", async () => {
    await open();
    await until(() => source.state.contexts.length === 1);
    let error;
    try { await source.loadVariables(999); } catch (e) { error = e; }
    expect(error && error.message).toMatch(/out of date/);
  });

  it("reads the module again when the helper announces a change, once for a burst", async () => {
    await open();
    await until(() => source.state.contexts.length === 1);
    server.helper.generation = 1;
    server.helper.changed();
    server.helper.changed();
    server.helper.changed();
    await until(() => source.state.contexts[0].items[0].value === "43", "refreshed value");
    expect(server.helper.count("ls")).toBe(2);
  });

  it("lists the loaded modules", async () => {
    await open();
    expect(await source.modules()).toEqual(["Main", "Main.Base", "Main.Foo", "Main.Foo.Bar"]);
    expect(server.helper.requests.some((r) => r.op === "modules" && r.arg === "")).toBe(true);
  });

  it("can watch another module", async () => {
    await open();
    await until(() => source.state.contexts.length === 1);
    await source.setModule("Main.Foo");
    expect(server.helper.requests[server.helper.requests.length - 1]).toEqual({ id: 2, op: "ls", arg: "Main.Foo" });
    expect(source.state.contexts[0].name).toBe("Main.Foo");
  });

  it("times out when the REPL is busy", async () => {
    await open({ silent: true }, { requestTimeout: 30 });
    let problem;
    source.on("problem", (e) => { problem = e; });
    await until(() => problem, "problem report");
    expect(problem.message).toMatch(/did not answer 'ls'/);
  });

  it("ends when the REPL goes away", async () => {
    await open();
    await until(() => source.state.contexts.length === 1);
    let ended = 0;
    source.on("ended", () => ended++);
    server.helper.socket.destroy();
    await until(() => source.state.status === "ended", "end");
    expect(ended).toBe(1);
    expect(source.state.contexts).toEqual([]);
    let error;
    try { await source.loadVariables(1); } catch (e) { error = e; }
    expect(error && error.message).toMatch(/no longer connected/);
  });

  it("copes with answers split across packets and with unreadable lines", async () => {
    await open({ silent: true });
    const problems = [];
    source.on("problem", (e) => problems.push(e.message));
    const h = server.helper;
    await until(() => h.requests.length === 1);
    h.socket.write("not json\n");
    const answer = JSON.stringify({ id: 1, ok: true, module: "Main", items: [{ name: "é✓", value: "1", type: "Int64", kind: "variable", ref: 0, truncated: false }] }) + "\n";
    const bytes = Buffer.from(answer, "utf8");
    for (let i = 0; i < bytes.length; i += 7) h.socket.write(bytes.slice(i, i + 7));
    await until(() => source.state.contexts.length === 1, "assembled answer");
    expect(names()).toEqual(["é✓"]);
    expect(problems[0]).toMatch(/unreadable/);
  });
});

describe("WorkspaceModel following a REPL", () => {
  let server, source, model, pane;

  beforeEach(async () => {
    server = await startFakeHelper();
    source = new ReplWorkspaceSource(await server.connect(), { refreshDelay: 10 });
    model = new WorkspaceModel();
    pane = new WorkspacePane(model, { document: fakeDocument() });
    model.setSession(source);
    await until(() => source.state.contexts.length === 1);
  });
  afterEach(async () => {
    pane.destroy();
    model.destroy();
    source.close();
    await server.close();
  });

  const variableNames = () => model.rows().filter((r) => r.kind === "variable").map((r) => r.name);

  it("shows the module as one scope, not stale", () => {
    expect(model.statusText()).toBe("REPL: Main");
    expect(model.stale).toBe(false);
    expect(model.rows()[0].kind).toBe("context");
    expect(model.rows()[0].name).toBe("Main");
    expect(variableNames()).toEqual(["x", "v", "C", "Foo", "f", "Base"]);
    expect(model.frames()).toEqual([]);
  });

  it("expands values and keeps them expanded when the REPL changes", async () => {
    await model.toggle(pathOf("Main", "v"));
    await until(() => variableNames().length === 9, "children");
    expect(model.rows().filter((r) => r.depth === 2).map((r) => r.value)).toEqual(["1", "2", "3"]);

    server.helper.generation = 1;
    server.helper.changed();
    await until(() => model.rows().find((r) => r.name === "x").value === "43", "new listing");
    await until(() => model.rows().filter((r) => r.depth === 2).map((r) => r.value).join() === "2,4,6", "children refreshed");
    expect(variableNames().length).toBe(9);
  });

  it("offers a refresh button that reads the module again", async () => {
    expect(model.canRefresh).toBe(true);
    const button = pane.element.querySelector("button.refresh");
    expect(button.classList.contains("hidden")).toBe(false);
    const before = server.helper.count("ls");
    button.click();
    await until(() => server.helper.count("ls") === before + 1, "second ls");
  });

  it("has no refresh button for a debug session", () => {
    const fake = Object.assign(new EventEmitter(), { state: { status: "running", loading: false, frames: [], contexts: [] } });
    model.setSession(fake);
    expect(model.canRefresh).toBe(false);
    pane.render();
    expect(pane.element.querySelector("button.refresh").classList.contains("hidden")).toBe(true);
  });
});

describe("choosing the module of a REPL", () => {
  let server, source, model, pane, chosen;
  const ls = () => server.helper.requests.filter((r) => r.op === "ls").map((r) => r.arg);

  beforeEach(async () => {
    server = await startFakeHelper();
    source = new ReplWorkspaceSource(await server.connect(), { refreshDelay: 10 });
    model = new WorkspaceModel();
    chosen = [];
    model.onDidChooseModule((c) => chosen.push(c));
    pane = new WorkspacePane(model, { document: fakeDocument() });
    model.setSession(source);
    await until(() => source.state.contexts.length === 1);
    await until(() => model.moduleNames.length > 0, "module names");
  });
  afterEach(async () => {
    pane.destroy();
    model.destroy();
    source.close();
    await server.close();
  });

  it("offers the modules and Follow editor in the pane", async () => {
    pane.render();
    const select = pane.element.querySelector("select.modules");
    expect(select.classList.contains("hidden")).toBe(false);
    expect(select.children.map((o) => o.textContent)).toEqual(["Follow editor", "Main", "Main.Base", "Main.Foo", "Main.Foo.Bar"]);
    expect(select.value).toBe("Main");
  });

  it("switches the listing when a module is chosen, and announces the choice", async () => {
    pane.render();
    const select = pane.element.querySelector("select.modules");
    select.value = "Main.Foo";
    select.dispatch("change");
    await until(() => model.statusText() === "REPL: Main.Foo", "new module");
    expect(ls()).toEqual(["Main", "Main.Foo"]);
    expect(chosen).toEqual(["Main.Foo"]);
  });

  it("restoring a saved choice switches the module without announcing it", async () => {
    model.setModuleChoice("Main.Foo.Bar");
    await until(() => model.statusText() === "REPL: Main.Foo.Bar", "restored module");
    expect(chosen).toEqual([]);
  });

  it("applies the saved choice when a REPL connects", async () => {
    const other = new WorkspaceModel();
    other.setModuleChoice("Main.Foo");
    const second = new ReplWorkspaceSource(await server.connect(), { refreshDelay: 10 });
    other.setSession(second);
    await until(() => other.statusText() === "REPL: Main.Foo", "module on connect");
    other.destroy();
    second.close();
  });

  it("keeps a chosen module in the menu even if the REPL does not list it", () => {
    model.setModuleChoice("Main.NotYet");
    pane.render();
    const select = pane.element.querySelector("select.modules");
    expect(select.children.map((o) => o.textContent)).toContain("Main.NotYet");
  });

  it("follows the editor to the deepest module that exists", async () => {
    model.chooseModule(FOLLOW);
    expect(model.following).toBe(true);
    await model.followTo(["Foo", "Bar", "Deeper"]);
    await until(() => model.statusText() === "REPL: Main.Foo.Bar", "followed");
    await model.followTo([]);
    await until(() => model.statusText() === "REPL: Main", "back at Main");
  });

  it("asks the REPL for its modules again when the editor's module is unknown", async () => {
    model.chooseModule(FOLLOW);
    const before = server.helper.count("modules");
    server.helper.moduleNames = ["Main", "Main.Fresh"];
    await model.followTo(["Fresh"]);
    expect(server.helper.count("modules")).toBeGreaterThan(before);
    await until(() => model.statusText() === "REPL: Main.Fresh", "fresh module");
  });

  it("does not follow when a fixed module is chosen", async () => {
    model.chooseModule("Main.Foo");
    expect(model.following).toBe(false);
    await model.followTo(["Foo", "Bar"]);
    await until(() => model.statusText() === "REPL: Main.Foo", "fixed module");
    expect(ls().filter((a) => a === "Main.Foo.Bar").length).toBe(0);
  });

  it("is hidden for a debug session", () => {
    const fake = Object.assign(new EventEmitter(), { state: { status: "running", loading: false, frames: [], contexts: [] } });
    model.setSession(fake);
    expect(model.canChooseModule).toBe(false);
    pane.render();
    expect(pane.element.querySelector("select.modules").classList.contains("hidden")).toBe(true);
  });
});

describe("ReplBridge", () => {
  let bridge, dir;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-")); bridge = new ReplBridge({ helper: "/pkg/julia/workspace.jl", tmpdir: dir }); });
  afterEach(() => { bridge.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("writes a startup file that loads the helper and connects to the socket", async () => {
    const { loadFile } = await bridge.prepare();
    expect(loadFile.startsWith(dir)).toBe(true);
    const text = fs.readFileSync(loadFile, "utf8");
    expect(text).toBe(bootstrapSource("/pkg/julia/workspace.jl", bridge.address));
    expect(text).toContain('include(raw"/pkg/julia/workspace.jl")');
    expect(text).toContain('Main.var"#PulsarIDEWorkspace".start(raw"');
  });

  it("escapes quotes in paths for the Julia string literal", () => {
    expect(bootstrapSource('/a"b/w.jl', "/p")).toContain('raw"/a\\"b/w.jl"');
  });

  it("hands out a source when Julia connects, and removes the startup file", async () => {
    const connected = [];
    bridge.onDidConnect((s) => connected.push(s));
    const { loadFile } = await bridge.prepare();
    const socket = net.connect(bridge.address);
    await until(() => connected.length === 1, "connection");
    expect(connected[0] instanceof ReplWorkspaceSource).toBe(true);
    expect(fs.existsSync(loadFile)).toBe(false);
    socket.destroy();
  });

  it("reports a disconnect when the REPL exits", async () => {
    const gone = [];
    bridge.onDidDisconnect((s) => gone.push(s));
    bridge.onDidConnect(() => {});
    await bridge.prepare();
    const socket = net.connect(bridge.address);
    await until(() => bridge.source, "source");
    const source = bridge.source;
    socket.destroy();
    await until(() => gone.length === 1, "disconnect");
    expect(gone[0]).toBe(source);
    expect(bridge.source).toBe(null);
  });

  it("prefers the newest REPL", async () => {
    const seen = [];
    bridge.onDidConnect((s) => seen.push(s));
    await bridge.prepare();
    const a = net.connect(bridge.address);
    await until(() => seen.length === 1);
    const b = net.connect(bridge.address);
    await until(() => seen.length === 2);
    expect(seen[0].state.status).toBe("ended");
    expect(bridge.source).toBe(seen[1]);
    a.destroy(); b.destroy();
  });

  it("cleans up the old socket and file when prepared again, and on dispose", async () => {
    const first = (await bridge.prepare()).loadFile;
    const firstAddress = bridge.address;
    const second = (await bridge.prepare()).loadFile;
    expect(fs.existsSync(first)).toBe(false);
    expect(second).not.toBe(first);
    await until(() => !fs.existsSync(firstAddress), "old socket removed");
    bridge.dispose();
    expect(fs.existsSync(second)).toBe(false);
  });
});

describe("DebugController and the REPL source", () => {
  const fakeSource = (name) => Object.assign(new EventEmitter(), { name, state: { status: "live", loading: false, frames: [], contexts: [{ name, ref: 0, lazy: false, items: [] }] } });
  let controller;

  beforeEach(() => {
    controller = new DebugController({ setting: () => undefined, notifications: {}, ui: { showLocation() {}, openWorkspace() {}, openOutput() {} } });
  });
  afterEach(() => { controller.destroy(); });

  it("shows the REPL in the pane when nothing is being debugged", () => {
    const repl = fakeSource("Main");
    controller.setReplSource(repl);
    expect(controller.model.session).toBe(repl);
    controller.setReplSource(null);
    expect(controller.model.session).toBe(null);
  });

  it("does not take the pane away from a running debug session", () => {
    const debugSession = Object.assign(new EventEmitter(), { state: { status: "stopped", loading: false, frames: [], contexts: [] } });
    controller.attach(debugSession, null);
    controller.setReplSource(fakeSource("Main"));
    expect(controller.model.session).toBe(debugSession);
  });

  it("goes back to the REPL when the debug session ends", () => {
    const repl = fakeSource("Main");
    controller.setReplSource(repl);
    const debugSession = Object.assign(new EventEmitter(), { state: { status: "stopped", loading: false, frames: [], contexts: [] } });
    controller.attach(debugSession, null);
    expect(controller.model.session).toBe(debugSession);
    debugSession.emit("ended");
    expect(controller.model.session).toBe(repl);
  });
});
