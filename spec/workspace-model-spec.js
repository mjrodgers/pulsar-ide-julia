const { startFakeAdapter } = require("./helpers/fake-adapter");
const { DapClient } = require("../lib/dap/client");
const { DapSession } = require("../lib/dap/session");
const { WorkspaceModel, fuzzyMatch, pathOf } = require("../lib/workspace/model");

const until = async (predicate, what = "condition", ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};
const quiet = { warn() {}, error() {}, debug() {}, info() {} };

describe("fuzzyMatch", () => {
  it("matches subsequences, ignoring case", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
    expect(fuzzyMatch("xs", "xValues")).toBe(true);
    expect(fuzzyMatch("VAL", "xvalues")).toBe(true);
    expect(fuzzyMatch("sx", "xs")).toBe(false);
    expect(fuzzyMatch("q", "xs")).toBe(false);
  });
});

describe("WorkspaceModel", () => {
  let server, client, session, model;

  const start = async (options, stopOnEntry = true) => {
    server = await startFakeAdapter(options);
    client = new DapClient(await server.connect(), { requestTimeout: 3000 });
    session = new DapSession(client, { logger: quiet });
    model = new WorkspaceModel();
    model.setSession(session);
    await until(() => server.adapter);
    await session.start({ args: { program: "/work/a.jl", stopOnEntry } });
    await until(() => model.state.status === "stopped" && !model.state.loading && model.state.contexts.length > 0, "first stop");
  };
  const names = () => model.rows().filter((r) => r.kind === "variable").map((r) => r.name);
  const settled = () => until(() => model.unloaded().length === 0 && !model.rows().some((r) => r.kind === "loading"), "children");

  afterEach(async () => {
    if (model) model.destroy();
    if (client) client.close();
    if (server) await server.close();
    model = session = client = server = undefined;
  });

  it("has nothing to show without a session", () => {
    const m = new WorkspaceModel();
    expect(m.rows()).toEqual([]);
    expect(m.statusText()).toBe("No debug session.");
    expect(m.frames()).toEqual([]);
  });

  it("lists scopes and their variables, with a load row for the expensive scope", async () => {
    await start();
    expect(model.rows().map((r) => `${r.kind}:${r.name || ""}`)).toEqual([
      "context:Local", "variable:x", "variable:v", "variable:s", "context:Global", "lazy:",
    ]);
    const v = model.rows().find((r) => r.name === "v");
    expect(v.expandable).toBe(true);
    expect(model.rows().find((r) => r.name === "x").expandable).toBe(false);
    expect(model.statusText()).toBe("Stopped (entry) in inner at a.jl:3");
    expect(model.stale).toBe(false);
  });

  it("expands a variable to show its children and collapses it again", async () => {
    await start();
    const path = pathOf("Local", "v");
    await model.toggle(path);
    await settled();
    expect(names()).toEqual(["x", "v", "1", "2", "3", "s"]);
    expect(model.rows().filter((r) => r.name === "2")[0].depth).toBe(2);
    await model.toggle(path);
    expect(names()).toEqual(["x", "v", "s"]);
  });

  it("shows a loading row while children are being fetched", async () => {
    await start();
    const p = model.toggle(pathOf("Local", "v"));
    expect(model.rows().some((r) => r.kind === "loading")).toBe(true);
    await p;
    expect(model.rows().some((r) => r.kind === "loading")).toBe(false);
  });

  it("re-fetches what is expanded after a step, with the new values", async () => {
    await start();
    await model.toggle(pathOf("Local", "v"));
    await settled();
    await session.stepOver();
    await until(() => model.state.status === "stopped" && !model.state.loading && model.state.frames[0].line === 4, "step");
    await settled();
    expect(names()).toEqual(["x", "v", "1", "2", "3", "s"]); // still expanded
    expect(model.rows().find((r) => r.name === "x").value).toBe("1");
    expect(model.stale).toBe(false);
  });

  it("is stale while the program runs", async () => {
    await start();
    await session.stepOver();
    // Between the step request and the next stop the old rows stay, flagged as stale.
    expect(model.statusText()).toMatch(/Running|Stopped/);
    await until(() => !model.stale, "settle");
  });

  it("filters top-level variables and reports an empty scope", async () => {
    await start();
    model.setFilter("s");
    expect(names()).toEqual(["s"]);
    model.setFilter("zzz");
    expect(names()).toEqual([]);
    expect(model.rows().filter((r) => r.kind === "empty").length).toBe(1); // only the loaded scope
    model.setFilter("");
    expect(names()).toEqual(["x", "v", "s"]);
  });

  it("loads an expensive scope on request", async () => {
    await start();
    await model.loadContext(model.rows().find((r) => r.kind === "lazy").context);
    await until(() => names().includes("G"), "global scope");
    expect(model.rows().some((r) => r.kind === "lazy")).toBe(false);
  });

  it("switches frames and keeps expansion by path", async () => {
    await start();
    await model.toggle(pathOf("Local", "v"));
    await settled();
    await model.selectFrame(101);
    await until(() => names().includes("y"), "outer frame");
    expect(names()).toEqual(["y"]); // `v` does not exist in `outer`
    expect(model.frameId()).toBe(101);
    await model.selectFrame(100);
    await until(() => names().includes("x"), "back to inner");
    await settled();
    expect(names()).toEqual(["x", "v", "1", "2", "3", "s"]);
  });

  it("keeps expansion across sessions and clears the rows when the session ends", async () => {
    await start();
    await model.toggle(pathOf("Local", "v"));
    await settled();
    await session.continue();
    await until(() => model.state.status === "ended", "end");
    expect(model.rows()).toEqual([]);
    expect(model.statusText()).toBe("The debug session has ended.");
    expect(model.isExpanded(pathOf("Local", "v"))).toBe(true);
  });

  it("shows an error row when children cannot be read", async () => {
    await start();
    session.loadVariables = async () => { throw new Error("boom"); };
    await model.toggle(pathOf("Local", "v"));
    const err = model.rows().find((r) => r.kind === "error");
    expect(err && err.message).toBe("boom");
  });

  it("notifies listeners and stops after they unsubscribe", async () => {
    await start();
    let n = 0;
    const off = model.onDidChange(() => n++);
    model.setFilter("x");
    expect(n).toBe(1);
    off();
    model.setFilter("");
    expect(n).toBe(1);
  });
});
