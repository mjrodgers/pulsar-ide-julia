// The language servers pane, against a fake registry and the fake DOM.
const { fakeDocument } = require("./helpers/fake-dom");
const { ServersPane, URI } = require("../lib/server/servers-pane");
// Node's own timers: Pulsar's spec runner replaces the window's setTimeout with a mock clock.
const { setTimeout: realTimeout } = require("timers");

const until = async (predicate, what = "condition", ms = 2000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};

function fakeRegistry(rows) {
  const calls = [];
  return {
    calls,
    rows,
    available: true,
    list: () => rows.map((r) => ({ ...r })),
    restart: async (root) => { calls.push(["restart", root]); const r = rows.find((x) => x.root === root); r.pid += 1000; return true; },
    stop: async (root) => { calls.push(["stop", root]); const r = rows.find((x) => x.root === root); r.status = "stopped"; r.pid = null; return true; },
    start: async (root) => { calls.push(["start", root]); const r = rows.find((x) => x.root === root); if (!r.editors) return false; r.status = "running"; r.pid = 9; return true; },
  };
}

describe("ServersPane", () => {
  let registry, pane, notes, samples;
  const make = (options = {}) => {
    pane = new ServersPane(registry, {
      document: fakeDocument(),
      interval: 0,
      sampleMemory: async (pids) => { samples.push(pids); return new Map(pids.map((p) => [p, p === 1 ? 3 * 1024 ** 3 : null])); },
      notify: (kind, msg) => notes.push([kind, msg]),
      ...options,
    });
    return pane;
  };
  const rowOf = (name) => pane.element.querySelectorAll(".server").find((r) => r.querySelector(".name").textContent === name);
  const cell = (name, cls) => rowOf(name).querySelector(`.${cls}`).textContent;
  const button = (name, cls) => rowOf(name).querySelector(`button.${cls}`);

  beforeEach(() => {
    notes = [];
    samples = [];
    registry = fakeRegistry([
      { root: "/w/Oscar/", name: "Oscar", status: "running", pid: 1, editors: 3 },
      { root: "/w/Nemo/", name: "Nemo", status: "running", pid: 2, editors: 1 },
      { root: "/w/magma_code/", name: "magma_code", status: "stopped", pid: null, editors: 0 },
    ]);
  });
  afterEach(() => pane && pane.destroy());

  it("is a pane item at its own URI", () => {
    make();
    expect(pane.getURI()).toBe(URI);
    expect(pane.getTitle()).toBe("Julia Language Servers");
  });

  it("shows each folder's server with its memory, and a total", async () => {
    make();
    await until(() => samples.length === 1 && !pane.refreshing, "the first sample");
    expect(samples[0]).toEqual([1, 2]);
    expect(cell("Oscar", "status")).toBe("running");
    expect(cell("Oscar", "pid")).toBe("1");
    expect(cell("Oscar", "memory")).toBe("3.0 GB");
    expect(cell("Nemo", "memory")).toBe("–");
    expect(cell("Oscar", "files")).toBe("3");
    expect(cell("magma_code", "pid")).toBe("–");
    expect(pane.summary.textContent).toBe("2 of 3 running · 3.0 GB+");
    expect(button("magma_code", "start")).toBeTruthy();
    expect(button("Oscar", "restart")).toBeTruthy();
  });

  it("restarts, stops and starts one folder from its row", async () => {
    make();
    await until(() => !pane.refreshing);
    button("Nemo", "restart").click();
    await until(() => registry.calls.length === 1 && !pane.busy.size && !pane.refreshing, "the restart");
    expect(registry.calls).toEqual([["restart", "/w/Nemo/"]]);
    expect(cell("Nemo", "pid")).toBe("1002");

    button("Nemo", "stop").click();
    await until(() => !pane.busy.size && !pane.refreshing && cell("Nemo", "status") === "stopped", "the stop");
    button("Nemo", "start").click();
    await until(() => !pane.busy.size && !pane.refreshing && cell("Nemo", "status") === "running", "the start");
  });

  it("explains why a folder with no Julia files does not start", async () => {
    make();
    button("magma_code", "start").click();
    await until(() => notes.length === 1 && !pane.busy.size, "the note");
    expect(notes[0][0]).toBe("addInfo");
  });

  it("reports a failed action", async () => {
    registry.stop = async () => { throw new Error("no answer"); };
    make();
    button("Oscar", "stop").click();
    await until(() => notes.length === 1, "the error");
    expect(notes[0]).toEqual(["addError", "could not stop the server: no answer"]);
  });

  it("offers to restart everything when given a way to", async () => {
    let all = 0;
    make({ restartAll: async () => { all++; } });
    pane.element.querySelector("button.restart-all").click();
    await until(() => all === 1, "restart all");
  });

  it("says so when per-folder control is not available", () => {
    registry.available = false;
    make();
    expect(pane.element.querySelectorAll(".server").length).toBe(0);
    expect(pane.summary.textContent).toMatch(/not available/);
  });

  it("stops refreshing once destroyed", async () => {
    make({ interval: 5 });
    await until(() => samples.length >= 2, "periodic refresh");
    pane.destroy();
    const count = samples.length;
    await new Promise((r) => realTimeout(r, 30));
    expect(samples.length).toBeLessThanOrEqual(count + 1);
  });
});
