// ServerRegistry against a fake of the fork's ServerManager (the real one is covered in fork-api-spec.js).
const { ServerRegistry, displayName } = require("../lib/server/registry");

const A = "/work/Oscar/";
const B = "/work/Nemo/";
const C = "/work/scratch/";

// A ServerManager-shaped fake: servers start when an editor of their root is handled, like the real one.
function fakeManager(roots) {
  let nextPid = 100;
  const m = {
    servers: [],
    _startingServerPromises: new Map(),
    stopped: [],
    handled: [],
    getActiveServers: () => m.servers,
    getNormalizedProjectPaths: () => roots,
    stopServer: async (server) => { m.servers = m.servers.filter((s) => s !== server); m.stopped.push(server.projectPath); },
    _handleTextEditor: async (editor) => {
      m.handled.push(editor);
      const root = editor.root;
      if (m.servers.some((s) => s.projectPath === root)) return;
      m.servers.push({ projectPath: root, process: { pid: nextPid++ } });
    },
  };
  return m;
}

const editor = (root, file, julia = true) => ({ root, julia, getPath: () => (file ? `${root}${file}` : null) });

function setup({ roots = [A, B, C], editors = [], running = [] } = {}) {
  const manager = fakeManager(roots);
  for (const r of running) manager.servers.push({ projectPath: r, process: { pid: 1 + running.indexOf(r) } });
  const client = { _serverManager: manager, determineProjectPath: (e) => e.root };
  const registry = new ServerRegistry({ client, workspace: { getTextEditors: () => editors }, isJulia: (e) => e.julia });
  return { registry, manager };
}

describe("ServerRegistry", () => {
  it("is available only when the fork has everything it needs", () => {
    expect(setup().registry.available).toBe(true);
    const { registry, manager } = setup();
    delete manager._handleTextEditor;
    expect(registry.available).toBe(false);
    expect(new ServerRegistry({ client: {}, workspace: {}, isJulia: () => true }).available).toBe(false);
  });

  it("lists every project folder with its server, process and open Julia files", () => {
    const editors = [editor(A, "src/Oscar.jl"), editor(A, "src/a.jl"), editor(A, "README.md", false), editor(C, "try.jl")];
    const { registry, manager } = setup({ editors, running: [A] });
    manager._startingServerPromises.set(C, new Promise(() => {}));
    expect(registry.list()).toEqual([
      { root: A, name: "Oscar", status: "running", pid: 1, editors: 2 },
      { root: B, name: "Nemo", status: "stopped", pid: null, editors: 0 },
      { root: C, name: "scratch", status: "starting", pid: null, editors: 1 },
    ]);
  });

  it("also lists a server for a folder outside the project", () => {
    const { registry } = setup({ roots: [A], running: [A, "/elsewhere/Dep/"] });
    expect(registry.list().map((r) => r.name)).toEqual(["Oscar", "Dep"]);
  });

  it("restarts one folder's server and leaves the others alone", async () => {
    const editors = [editor(A, "src/a.jl"), editor(B, "src/b.jl")];
    const { registry, manager } = setup({ editors, running: [A, B] });
    expect(await registry.restart(A)).toBe(true);
    expect(manager.stopped).toEqual([A]);
    expect(manager.handled).toEqual([editors[0]]);
    const rows = registry.list();
    expect(rows[0].status).toBe("running");
    expect(rows[0].pid).toBe(100); // a new process
    expect(rows[1].pid).toBe(2);   // untouched
  });

  it("waits for a server that is still starting before stopping it", async () => {
    const { registry, manager } = setup({ editors: [editor(A, "a.jl")] });
    const server = { projectPath: A, process: { pid: 7 } };
    let resolve;
    manager._startingServerPromises.set(A, new Promise((r) => { resolve = r; }));
    const stopping = registry.stop(A);
    manager.servers.push(server);
    manager._startingServerPromises.delete(A);
    resolve(server);
    expect(await stopping).toBe(true);
    expect(manager.stopped).toEqual([A]);
  });

  it("stops and starts, and does not start a folder with no open Julia files", async () => {
    const { registry, manager } = setup({ editors: [editor(A, "a.jl"), editor(B, "x.md", false)], running: [A, B] });
    expect(await registry.stop(A)).toBe(true);
    expect(registry.list()[0].status).toBe("stopped");
    expect(await registry.stop(A)).toBe(false); // nothing to stop
    expect(await registry.start(A)).toBe(true);
    expect(registry.list()[0].status).toBe("running");
    await registry.stop(B);
    expect(await registry.start(B)).toBe(false);
    expect(manager.handled.length).toBe(1);
  });

  it("finds the folder of an editor, or none", () => {
    const { registry } = setup();
    expect(registry.rootOf(editor(B, "src/b.jl"))).toBe(B);
    expect(registry.rootOf(editor(B, null))).toBe(null);
    expect(registry.rootOf(null)).toBe(null);
  });

  it("names folders by their last component", () => {
    expect(displayName("/work/Oscar/")).toBe("Oscar");
    expect(displayName("/work/GAP.jl")).toBe("GAP.jl");
  });
});
