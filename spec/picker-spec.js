const { fakeDocument } = require("./helpers/fake-dom");
const { Picker } = require("../lib/picker");

describe("Picker", () => {
  let picker, panels;
  beforeEach(() => {
    panels = [];
    const workspace = { addModalPanel: ({ item }) => { const p = { item, destroyed: false, destroy() { p.destroyed = true; } }; panels.push(p); return p; } };
    picker = new Picker({ workspace, document: fakeDocument() });
  });

  const element = () => panels[panels.length - 1].item;
  const input = () => element().querySelector("input");
  const labels = () => element().querySelectorAll("li").map((li) => li.textContent);
  const press = (key) => input().dispatch("keydown", { key });
  const type = (text) => { input().value = text; input().dispatch("input"); };

  it("lists the items and focuses the filter", () => {
    picker.pick(["a", "b", "c"], { placeholder: "Pick" });
    expect(labels()).toEqual(["a", "b", "c"]);
    expect(input().focused).toBe(true);
    expect(input().getAttribute("placeholder")).toBe("Pick");
  });

  it("returns the selected item on Enter, after moving with the arrows", async () => {
    const result = picker.pick(["a", "b", "c"]);
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown"); // wraps to the first
    press("ArrowUp");
    press("Enter");
    expect(await result).toBe("c");
    expect(panels[0].destroyed).toBe(true);
  });

  it("filters while typing", async () => {
    const result = picker.pick(["alpha", "beta", "gamma"]);
    type("ta");
    expect(labels()).toEqual(["beta"]);
    press("Enter");
    expect(await result).toBe("beta");
  });

  it("returns null for Escape, for Enter with no match, and when it loses focus", async () => {
    let result = picker.pick(["a"]);
    press("Escape");
    expect(await result).toBe(null);

    result = picker.pick(["a"]);
    type("zzz");
    press("Enter");
    expect(await result).toBe(null);

    result = picker.pick(["a"]);
    input().dispatch("blur");
    expect(await result).toBe(null);
  });

  it("picks an item with the mouse", async () => {
    const result = picker.pick(["a", "b"]);
    element().querySelectorAll("li")[1].dispatch("mousedown");
    expect(await result).toBe("b");
  });

  it("closes the earlier list when another is opened", async () => {
    const first = picker.pick(["a"]);
    picker.pick(["b"]);
    expect(await first).toBe(null);
    expect(panels[0].destroyed).toBe(true);
    expect(panels[1].destroyed).toBe(false);
    picker.destroy();
    expect(panels[1].destroyed).toBe(true);
  });
});
