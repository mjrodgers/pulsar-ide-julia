// Waiting for Pulsar to load the shell's environment before starting JETLS or the debugger.
const { waitForShellEnvironment, shellEnvironment } = require("../lib/shell-env");

function fakeApi({ loaded = false, specMode = false } = {}) {
  const callbacks = [];
  const api = {
    disposed: 0,
    inSpecMode: () => specMode,
    whenShellEnvironmentLoaded(fn) {
      if (loaded) { fn(); return { dispose: () => { api.disposed++; } }; }
      callbacks.push(fn);
      return { dispose: () => { api.disposed++; } };
    },
    load() { loaded = true; callbacks.splice(0).forEach((fn) => fn()); },
  };
  return api;
}

describe("waiting for the shell environment", () => {
  afterEach(() => shellEnvironment.reset());

  it("goes on at once when it is already loaded", async () => {
    const api = fakeApi({ loaded: true });
    expect(await waitForShellEnvironment({ api, timeout: 5000 })).toBe(true);
  });

  it("waits until Pulsar has loaded it", async () => {
    const api = fakeApi();
    let result;
    const waiting = waitForShellEnvironment({ api, timeout: 5000 }).then((r) => { result = r; });
    await new Promise((r) => setImmediate(r));
    expect(result).toBeUndefined();
    api.load();
    await waiting;
    expect(result).toBe(true);
    expect(api.disposed).toBe(1);
  });

  it("gives up after the timeout", async () => {
    const api = fakeApi();
    expect(await waitForShellEnvironment({ api, timeout: 20 })).toBe(false);
    expect(api.disposed).toBe(1);
  });

  it("does not wait without the API or in spec windows", async () => {
    expect(await waitForShellEnvironment({ api: {} })).toBe(true);
    expect(await waitForShellEnvironment({ api: fakeApi({ specMode: true }), timeout: 5000 })).toBe(true);
  });

  it("waits at most once per window", async () => {
    const api = fakeApi();
    expect(await shellEnvironment({ api, timeout: 20 })).toBe(false);
    const t0 = Date.now();
    expect(await shellEnvironment({ api, timeout: 5000 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
