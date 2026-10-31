// One document-symbol request per version of a file's text (lib/server/symbol-cache.js).
const { SymbolCache } = require("../lib/server/symbol-cache");

function fakeEditor() {
  const listeners = { change: [], path: [], destroy: [] };
  const on = (kind) => (fn) => { listeners[kind].push(fn); return { dispose: () => { listeners[kind] = listeners[kind].filter((f) => f !== fn); } }; };
  return {
    listeners,
    getBuffer: () => ({ onDidChange: on("change") }),
    onDidChangePath: on("path"),
    onDidDestroy: on("destroy"),
    type() { listeners.change.forEach((f) => f()); },
    rename() { listeners.path.forEach((f) => f()); },
    destroy() { listeners.destroy.slice().forEach((f) => f()); },
  };
}

describe("document symbol cache", () => {
  let calls, reply, cache;
  beforeEach(() => {
    calls = 0;
    reply = () => [{ name: "f" }];
    cache = new SymbolCache(async () => { calls++; return reply(); });
  });

  it("asks once for the same text, also while a request is on its way", async () => {
    const editor = fakeEditor();
    const [a, b] = await Promise.all([cache.get(editor), cache.get(editor)]);
    expect(a).toBe(b);
    await cache.get(editor);
    expect(calls).toBe(1);
  });

  it("asks again after an edit or a rename", async () => {
    const editor = fakeEditor();
    await cache.get(editor);
    editor.type();
    await cache.get(editor);
    editor.rename();
    await cache.get(editor);
    expect(calls).toBe(3);
    cache.clear();
    await cache.get(editor);
    expect(calls).toBe(4);
  });

  it("keeps no failures and no empty answers", async () => {
    const editor = fakeEditor();
    reply = () => null;
    expect(await cache.get(editor)).toBe(null);
    reply = () => { throw new Error("not ready"); };
    let error;
    try { await cache.get(editor); } catch (e) { error = e; }
    expect(error.message).toBe("not ready");
    reply = () => [];
    await cache.get(editor);
    await cache.get(editor);
    expect(calls).toBe(3);
  });

  it("lets go of closed editors", async () => {
    const editor = fakeEditor();
    await cache.get(editor);
    editor.destroy();
    expect(cache.entries.size).toBe(0);
    expect(editor.listeners.change.length).toBe(0);
    await cache.get(editor);
    expect(calls).toBe(2);
    cache.dispose();
    expect(cache.entries.size).toBe(0);
  });
});
