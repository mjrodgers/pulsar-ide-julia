const { fakeDocument } = require("./helpers/fake-dom");
const { startFakeAdapter } = require("./helpers/fake-adapter");
const { DapClient } = require("../lib/dap/client");
const { DapSession } = require("../lib/dap/session");
const { WorkspaceModel, pathOf } = require("../lib/workspace/model");
const { WorkspacePane } = require("../lib/workspace/pane");

const until = async (predicate, what = "condition", ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};
const quiet = { warn() {}, error() {}, debug() {}, info() {} };

describe("WorkspacePane", () => {
  let server, client, session, model, pane;

  const rowTexts = () => pane.element.querySelectorAll(".row").map((r) => r.textContent);
  const variable = (name) => pane.element.querySelectorAll(".variable").find((r) => r.querySelector(".name").textContent === name);
  const settle = () => until(() => !pane.renderQueued && !model.stale, "settled");

  beforeEach(async () => {
    server = await startFakeAdapter();
    client = new DapClient(await server.connect(), { requestTimeout: 3000 });
    session = new DapSession(client, { logger: quiet });
    model = new WorkspaceModel();
    pane = new WorkspacePane(model, { document: fakeDocument() });
    model.setSession(session);
    await until(() => server.adapter);
  });

  afterEach(async () => {
    pane.destroy();
    model.destroy();
    client.close();
    await server.close();
  });

  const stopAtEntry = async () => {
    await session.start({ args: { program: "/work/a.jl", stopOnEntry: true } });
    await until(() => model.state.status === "stopped" && !model.state.loading && model.state.contexts.length > 0);
    await settle();
  };

  it("identifies itself as a pane item", () => {
    expect(pane.getTitle()).toBe("Julia Workspace");
    expect(pane.getURI()).toBe("atom://pulsar-ide-julia/workspace");
    expect(pane.getDefaultLocation()).toBe("right");
    expect(pane.getElement()).toBe(pane.element);
  });

  it("shows a hint before anything is debugged", () => {
    expect(pane.status.textContent).toBe("No debug session.");
    expect(pane.list.querySelector(".hint")).not.toBeNull();
  });

  it("draws scopes, variables, types and values when stopped", async () => {
    await stopAtEntry();
    expect(pane.status.textContent).toBe("Stopped (entry) in inner at a.jl:3");
    expect(rowTexts()).toEqual([
      "Local", "xInt64" + "0", "▸vVector{Int64}[1, 2, 3]", 'sString"hello"', "Global", "Load variables (can be slow)",
    ]);
    expect(variable("v").classList.contains("expandable")).toBe(true);
    expect(variable("x").classList.contains("expandable")).toBe(false);
    expect(variable("s").querySelector(".value").getAttribute("title")).toBe('"hello"');
  });

  it("expands a variable when its row is clicked", async () => {
    await stopAtEntry();
    variable("v").click();
    await until(() => pane.list.querySelectorAll(".variable").length === 6, "children rendered");
    expect(pane.list.querySelectorAll(".variable").map((r) => r.querySelector(".name").textContent)).toEqual(["x", "v", "1", "2", "3", "s"]);
    expect(variable("v").classList.contains("expanded")).toBe(true);
    expect(variable("v").getAttribute("data-path")).toBe(pathOf("Local", "v"));
    variable("v").click();
    await until(() => pane.list.querySelectorAll(".variable").length === 3, "collapsed");
  });

  it("does nothing when a leaf row is clicked", async () => {
    await stopAtEntry();
    variable("x").click();
    expect(model.expanded.size).toBe(0);
  });

  it("filters while typing", async () => {
    await stopAtEntry();
    pane.filterInput.value = "s";
    pane.filterInput.dispatch("input");
    await until(() => pane.list.querySelectorAll(".variable").length === 1, "filtered");
    expect(variable("s")).toBeDefined();
  });

  it("loads the expensive scope from its link", async () => {
    await stopAtEntry();
    pane.list.querySelector(".lazy").click();
    await until(() => variable("G"), "global variable");
    expect(pane.list.querySelector(".lazy")).toBeNull();
  });

  it("lists the stack in a drop-down and switches frames", async () => {
    await stopAtEntry();
    expect(pane.frameSelect.children.map((o) => o.textContent)).toEqual(["0: inner — a.jl:3", "1: outer — a.jl:20"]);
    expect(pane.frameSelect.value).toBe("100");
    pane.frameSelect.value = "101";
    pane.frameSelect.dispatch("change");
    await until(() => variable("y"), "outer frame variables");
    expect(variable("x")).toBeUndefined();
    expect(pane.frameSelect.value).toBe("101");
  });

  it("dims stale values while the program runs, and undims at the next stop", async () => {
    await stopAtEntry();
    await session.stepOver();
    await until(() => !pane.renderQueued && !model.stale && model.state.frames[0].line === 4, "next stop");
    expect(pane.element.classList.contains("stale")).toBe(false);
    expect(variable("x").querySelector(".value").textContent).toBe("1");
  });

  it("empties when the session ends", async () => {
    await stopAtEntry();
    await session.continue();
    await until(() => model.state.status === "ended");
    await until(() => !pane.renderQueued);
    expect(pane.status.textContent).toBe("The debug session has ended.");
    expect(pane.list.querySelector(".hint")).not.toBeNull();
  });

  it("truncates very long values but keeps them in the tooltip", async () => {
    await stopAtEntry();
    const long = "x".repeat(1000);
    session.setState({ contexts: [{ name: "Local", ref: 1, lazy: false, items: [{ name: "big", value: long, type: "String", ref: 0 }] }] });
    await until(() => variable("big"));
    expect(variable("big").querySelector(".value").textContent.length).toBe(301);
    expect(variable("big").querySelector(".value").getAttribute("title").length).toBe(1000);
  });

  it("stops redrawing after it is destroyed and tells its listeners", () => {
    let destroyed = 0;
    pane.onDidDestroy(() => destroyed++);
    pane.destroy();
    pane.destroy();
    expect(destroyed).toBe(1);
  });
});
