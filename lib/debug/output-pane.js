// Shows the OutputLog: what the debugged program prints, plus the adapter's messages. Plain DOM.
const { createH } = require("../workspace/dom");

const URI = "atom://pulsar-ide-julia/debug-output";

class OutputPane {
  constructor(log, { document: doc = global.document } = {}) {
    this.log = log;
    this.h = createH(doc);
    this.destroyed = false;
    this.destroyListeners = [];

    const h = this.h;
    this.pre = h("pre", { class: "log native-key-bindings", tabindex: "-1" });
    this.element = h("div", { class: "pulsar-ide-julia-output" },
      h("div", { class: "toolbar" }, h("button", { class: "btn btn-sm clear", onclick: () => this.log.clear() }, "Clear")),
      this.pre);
    log.chunks.forEach((c) => this.appendChunk(c));
    this.unsubscribe = log.onDidAppend((chunk) => (chunk ? this.appendChunk(chunk) : this.clearView()));
  }

  appendChunk(chunk) {
    const pre = this.pre;
    // Only follow the output if the reader is already at the bottom.
    const atBottom = !pre.scrollHeight || pre.scrollHeight - pre.scrollTop - (pre.clientHeight || 0) < 24;
    pre.appendChild(this.h("span", { class: chunk.category }, chunk.text));
    if (atBottom && pre.scrollHeight) pre.scrollTop = pre.scrollHeight;
  }

  clearView() {
    this.h.replaceChildren(this.pre, []);
  }

  getTitle() { return "Julia Debug Output"; }
  getLongTitle() { return "Julia Debug Output"; }
  getURI() { return URI; }
  getIconName() { return "terminal"; }
  getDefaultLocation() { return "bottom"; }
  getAllowedLocations() { return ["bottom", "left", "right"]; }
  getElement() { return this.element; }
  focus() { this.pre.focus(); }
  onDidDestroy(fn) { this.destroyListeners.push(fn); return { dispose: () => { this.destroyListeners = this.destroyListeners.filter((f) => f !== fn); } }; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.destroyListeners.forEach((fn) => fn());
  }
}

module.exports = { OutputPane, URI };
