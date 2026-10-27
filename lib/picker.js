// A small modal list with a filter box, for choosing one string (a shared Julia environment, say).
// Plain DOM; `pick()` resolves with the choice, or null if the user dismisses it.
const { fuzzyMatch } = require("./workspace/model");
const { createH } = require("./workspace/dom");

class Picker {
  constructor({ workspace, document: doc = global.document }) {
    this.workspace = workspace;
    this.h = createH(doc);
    this.panel = null;
    this.current = null; // resolves the open list with null
  }

  pick(items, { placeholder = "" } = {}) {
    if (this.current) this.current(null);
    return new Promise((resolve) => {
      const h = this.h;
      let shown = items.slice();
      let index = 0;
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (this.current === finish) this.current = null;
        this.close();
        resolve(value);
      };
      this.current = finish;
      const list = h("ol", { class: "list-group" });
      const draw = () => {
        h.replaceChildren(list, shown.map((item, i) =>
          h("li", { class: i === index ? "selected" : "", onmousedown: (event) => { event.preventDefault(); finish(item); }, onmousemove: () => { if (index !== i) { index = i; draw(); } } }, item)));
      };
      const input = h("input", {
        class: "input-text native-key-bindings",
        type: "text",
        placeholder,
        oninput: () => { shown = items.filter((it) => fuzzyMatch(input.value, it)); index = 0; draw(); },
        onkeydown: (event) => {
          const key = event.key;
          if (key === "Escape") { event.preventDefault(); finish(null); }
          else if (key === "Enter") { event.preventDefault(); finish(shown[index] === undefined ? null : shown[index]); }
          else if (key === "ArrowDown") { event.preventDefault(); if (shown.length) { index = (index + 1) % shown.length; draw(); } }
          else if (key === "ArrowUp") { event.preventDefault(); if (shown.length) { index = (index - 1 + shown.length) % shown.length; draw(); } }
        },
        onblur: () => finish(null),
      });
      const element = h("div", { class: "pulsar-ide-julia-picker select-list" }, input, list);
      draw();
      this.panel = this.workspace.addModalPanel({ item: element, visible: true });
      input.focus();
    });
  }

  close() {
    if (this.panel) this.panel.destroy();
    this.panel = null;
  }

  destroy() {
    if (this.current) this.current(null);
    this.close();
  }
}

module.exports = { Picker };
