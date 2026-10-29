// Inline results, with a fake editor and DOM (no Pulsar needed).
const { InlineResults, formatDuration, lastRow } = require("../lib/results");
const { fakeDocument } = require("./helpers/fake-dom");

function fakeEditor(lines = ["x = 1", "    y = [1, 2, 3]", "z = 2"]) {
  const editor = {
    markers: [],
    decorations: [],
    destroyCallbacks: [],
    lineTextForBufferRow: (row) => lines[row],
    indentationForBufferRow: (row) => (lines[row].match(/^ */)[0].length / 4),
    getTabLength: () => 4,
    onDidDestroy: (fn) => { editor.destroyCallbacks.push(fn); return { dispose: () => {} }; },
    markBufferRange(range, options) {
      const listeners = [];
      const marker = {
        range, options, destroyed: false,
        onDidChange: (fn) => { listeners.push(fn); return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) }; },
        invalidate: () => listeners.slice().forEach((fn) => fn({ isValid: false })),
        destroy: () => { marker.destroyed = true; },
      };
      editor.markers.push(marker);
      return marker;
    },
    decorateMarker(marker, options) {
      editor.decorations.push({ marker, options });
      return {};
    },
  };
  return editor;
}

describe("inline results", () => {
  let results, editor, opened;
  const element = (i = 0) => editor.decorations[i].options.item;
  const live = () => editor.markers.filter((m) => !m.destroyed).length;

  beforeEach(() => {
    opened = [];
    results = new InlineResults({
      document: fakeDocument(),
      readFile: (file) => Buffer.from(`data of ${file}`),
      openFile: (file) => opened.push(file),
    });
    editor = fakeEditor();
  });

  it("shows that the code is running, under its last line", () => {
    results.begin(1, editor, [[1, 4], [2, 0]]);
    const { marker, options } = editor.decorations[0];
    expect(options.type).toBe("block");
    expect(options.position).toBe("after");
    expect(marker.range).toEqual([[1, 4], [1, 17]]); // a range ending at column 0 ends on the row before
    expect(marker.options.invalidate).toBe("inside");
    expect(element().className).toContain("pending");
    expect(element().textContent).toContain("running");
  });

  it("shows a value, and all of it on a click", () => {
    results.begin(1, editor, [[1, 4], [1, 17]]);
    results.report({ event: "result", id: 1, ms: 12, kind: "value", text: "[1, 2, 3]", full: "3-element Vector{Int64}:\n 1\n 2\n 3" });
    const el = element();
    expect(el.className).toContain("value");
    expect(el.className).toContain("expandable");
    expect(el.querySelector(".result-text").textContent).toBe("[1, 2, 3]");
    expect(el.querySelector(".result-time").textContent).toBe("12 ms");
    expect(el.querySelector("pre")).toBe(null);
    el.querySelector(".result-header").click();
    expect(el.querySelector("pre").textContent).toContain("3-element Vector{Int64}");
    el.querySelector(".result-header").click();
    expect(el.querySelector("pre")).toBe(null);
  });

  it("shows nothing but a check mark for `nothing`, and errors with their line", () => {
    results.begin(1, editor, [[0, 0], [0, 5]]);
    results.report({ id: 1, ms: 1500, kind: "nothing" });
    expect(element(0).className).toContain("nothing");
    expect(element(0).querySelector(".result-text")).toBe(null);
    expect(element(0).querySelector(".result-time").textContent).toBe("1.50 s");

    results.begin(2, editor, [[2, 0], [2, 5]]);
    results.report({ id: 2, ms: 1, kind: "error", text: "UndefVarError: `q` not defined", full: "ERROR: UndefVarError…", line: 3 });
    expect(element(1).className).toContain("error");
    expect(element(1).querySelector(".result-text").textContent).toBe("UndefVarError: `q` not defined  (line 3)");
  });

  it("shows images, and opens them in a tab on a click", () => {
    results.begin(1, editor, [[0, 0], [0, 5]]);
    results.report({ id: 1, ms: 1, kind: "image", mime: "image/png", file: "/tmp/result-1.png", text: "Plot{...}" });
    const img = element().querySelector("img");
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${Buffer.from("data of /tmp/result-1.png").toString("base64")}`);
    img.click();
    expect(opened).toEqual(["/tmp/result-1.png"]);
  });

  it("replaces the result of code ending on the same line, and goes away when the code is edited", () => {
    results.begin(1, editor, [[0, 0], [0, 5]]);
    results.begin(2, editor, [[0, 2], [0, 5]]);
    expect(editor.markers[0].destroyed).toBe(true);
    expect(live()).toBe(1);
    editor.markers[1].invalidate();
    expect(live()).toBe(0);
    results.report({ id: 2, kind: "value", text: "1" }); // too late: ignored
    expect(results.views.size).toBe(0);
  });

  it("keeps a result that arrives before the code is marked, and can be dismissed or cleared", () => {
    results.report({ id: 5, ms: 0, kind: "value", text: "5" });
    results.begin(5, editor, [[0, 0], [0, 5]]);
    expect(element().querySelector(".result-text").textContent).toBe("5");
    element().querySelector(".result-close").click();
    expect(live()).toBe(0);

    results.begin(6, editor, [[0, 0], [0, 5]]);
    results.begin(7, editor, [[2, 0], [2, 5]]);
    results.clear(editor);
    expect(live()).toBe(0);
    results.begin(8, editor, [[0, 0], [0, 5]]);
    results.cancel(8);
    expect(live()).toBe(0);
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(61000)).toBe("1 min 1 s");
    expect(formatDuration(3723000)).toBe("1 h 2 min");
    expect(formatDuration(undefined)).toBe("");
    expect(lastRow({ start: { row: 1, column: 0 }, end: { row: 3, column: 0 } })).toBe(2);
  });
});
