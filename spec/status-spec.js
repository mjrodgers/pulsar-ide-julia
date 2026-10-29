// The REPL's status bar tile, with a fake bridge and source.
const { EventEmitter } = require("events");
const { ReplStatus } = require("../lib/status");
const { fakeDocument } = require("./helpers/fake-dom");

function fakeBridge() {
  const connect = new Set();
  const disconnect = new Set();
  return {
    source: null,
    onDidConnect: (fn) => { connect.add(fn); return { dispose: () => connect.delete(fn) }; },
    onDidDisconnect: (fn) => { disconnect.add(fn); return { dispose: () => disconnect.delete(fn) }; },
    connect(source) { this.source = source; connect.forEach((fn) => fn(source)); },
    disconnect() { this.source = null; disconnect.forEach((fn) => fn()); },
  };
}

function fakeSource(state) {
  const source = new EventEmitter();
  source.state = { status: "live", contexts: [], busy: false, ...state };
  source.set = (patch) => { source.state = { ...source.state, ...patch }; source.emit("state", source.state); };
  return source;
}

describe("REPL status bar tile", () => {
  let bridge, status, clicks;
  beforeEach(() => {
    clicks = 0;
    bridge = fakeBridge();
    status = new ReplStatus({ bridge, onClick: () => clicks++, document: fakeDocument() });
  });
  afterEach(() => status.dispose());

  const el = () => status.element;

  it("is hidden until a REPL is connected, and after it has gone", () => {
    expect(el().classList.contains("hidden")).toBe(true);
    bridge.connect(fakeSource({ contexts: [{ name: "Main", items: [] }] }));
    expect(el().classList.contains("hidden")).toBe(false);
    expect(el().textContent).toBe("Julia: Main");
    bridge.disconnect();
    expect(el().classList.contains("hidden")).toBe(true);
  });

  it("shows the module, the busy state and the time of the last send", () => {
    const source = fakeSource({ contexts: [{ name: "Watch", watch: true, items: [] }, { name: "Main.Foo", items: [] }] });
    bridge.connect(source);
    expect(el().textContent).toBe("Julia: Main.Foo");
    source.set({ busy: true });
    expect(el().classList.contains("busy")).toBe(true);
    expect(el().textContent).toBe("Julia: Main.Foo running…");
    source.set({ busy: false, lastMs: 1250 });
    expect(el().textContent).toBe("Julia: Main.Foo · 1.25 s");
    expect(el().getAttribute("title")).toMatch(/took 1.25 s/);
  });

  it("opens the workspace when clicked, and goes into the status bar", () => {
    el().click();
    expect(clicks).toBe(1);
    const tiles = [];
    const statusBar = { addRightTile: (t) => { const tile = { ...t, destroyed: false, destroy() { tile.destroyed = true; } }; tiles.push(tile); return tile; } };
    const attached = status.attach(statusBar);
    expect(tiles[0].item).toBe(el());
    attached.dispose();
    expect(tiles[0].destroyed).toBe(true);
  });
});
