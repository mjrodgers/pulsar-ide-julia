// The Julia Workspace pane: scopes and variables of the selected stack frame while the debugger is stopped.
// Plain DOM, drawn from a WorkspaceModel; no etch.
const { createH } = require("./dom");
const { FOLLOW } = require("./module-follow");

const URI = "atom://pulsar-ide-julia/workspace";
const MAX_VALUE_LENGTH = 300;

const clip = (text) => {
  const one = String(text == null ? "" : text).replace(/\s*\n\s*/g, " ");
  return one.length > MAX_VALUE_LENGTH ? one.slice(0, MAX_VALUE_LENGTH) + "…" : one;
};

class WorkspacePane {
  constructor(model, { document: doc = global.document } = {}) {
    this.model = model;
    this.h = createH(doc);
    this.destroyed = false;
    this.renderQueued = false;
    this.destroyListeners = [];
    this.frameKey = null;
    this.moduleKey = null;

    const h = this.h;
    this.status = h("div", { class: "status" });
    this.refreshButton = h("button", { class: "refresh btn btn-sm icon icon-sync", title: "Read the variables again", onclick: () => this.model.refresh() }, "Refresh");
    this.moduleSelect = h("select", { class: "modules input-select", title: "Which module's variables to show", onchange: () => this.model.chooseModule(this.moduleSelect.value) });
    this.frameSelect = h("select", { class: "frames input-select", onchange: () => this.onFrameChange() });
    this.filterInput = h("input", {
      class: "filter input-text native-key-bindings",
      type: "text",
      placeholder: "Filter variables",
      oninput: () => this.model.setFilter(this.filterInput.value),
    });
    this.list = h("div", { class: "rows" });
    this.element = h("div", { class: "pulsar-ide-julia-workspace", tabindex: "-1" },
      h("div", { class: "header" }, h("div", { class: "top" }, this.status, this.refreshButton), this.moduleSelect, this.frameSelect, this.filterInput),
      this.list);

    this.unsubscribe = model.onDidChange(() => this.scheduleRender());
    this.render();
  }

  // --- pane item interface ---------------------------------------------------------------------
  getTitle() { return "Julia Workspace"; }
  getLongTitle() { return "Julia Workspace"; }
  getURI() { return URI; }
  getIconName() { return "list-unordered"; }
  getDefaultLocation() { return "right"; }
  getAllowedLocations() { return ["left", "right", "bottom"]; }
  getPreferredWidth() { return 320; }
  getElement() { return this.element; }
  focus() { this.filterInput.focus(); }
  onDidDestroy(fn) { this.destroyListeners.push(fn); return { dispose: () => { this.destroyListeners = this.destroyListeners.filter((f) => f !== fn); } }; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe();
    this.destroyListeners.forEach((fn) => fn());
  }

  // --- drawing ---------------------------------------------------------------------------------
  scheduleRender() {
    if (this.renderQueued || this.destroyed) return;
    this.renderQueued = true;
    Promise.resolve().then(() => { this.renderQueued = false; if (!this.destroyed) this.render(); });
  }

  render() {
    const model = this.model;
    this.status.textContent = model.statusText();
    this.element.classList.toggle("stale", model.stale);
    this.refreshButton.classList.toggle("hidden", !model.canRefresh);
    this.renderModules();
    this.renderFrames();
    const scroll = this.list.scrollTop;
    const rows = model.rows();
    this.h.replaceChildren(this.list, rows.length ? rows.map((r) => this.renderRow(r)) : [this.h("div", { class: "hint" }, "Variables of the current stack frame appear here while the debugger is stopped.")]);
    this.list.scrollTop = scroll;
  }

  // "Follow editor" and the REPL's modules; only shown for a REPL, a debugger session shows its stack frame.
  renderModules() {
    const model = this.model;
    const show = model.canChooseModule;
    this.moduleSelect.classList.toggle("hidden", !show);
    const choice = model.moduleChoice;
    const names = model.moduleNames.includes(choice) || choice === FOLLOW ? model.moduleNames : [...model.moduleNames, choice];
    const key = show ? `${choice}|${names.join(";")}` : "";
    if (key === this.moduleKey) return;
    this.moduleKey = key;
    if (!show) return;
    const options = [["Follow editor", FOLLOW], ...names.map((n) => [n, n])];
    this.h.replaceChildren(this.moduleSelect, options.map(([label, value]) => this.h("option", { value, selected: value === choice }, label)));
    this.moduleSelect.value = choice;
  }

  renderFrames() {
    const frames = this.model.frames();
    const selected = this.model.frameId();
    const key = frames.map((f) => `${f.id}|${f.name}|${f.line}`).join(";") + `@${selected}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    this.frameSelect.classList.toggle("hidden", frames.length === 0);
    this.h.replaceChildren(this.frameSelect, frames.map((f, i) => {
      const where = f.file ? ` — ${String(f.file).split(/[\\/]/).pop()}:${f.line}` : "";
      return this.h("option", { value: String(f.id), selected: f.id === selected, title: f.file }, `${i}: ${f.name}${where}`);
    }));
    this.frameSelect.value = selected === undefined ? "" : String(selected);
  }

  onFrameChange() {
    const id = Number(this.frameSelect.value);
    if (!Number.isNaN(id)) this.model.selectFrame(id);
  }

  renderRow(row) {
    const h = this.h;
    const style = `--depth:${row.depth}`;
    switch (row.kind) {
      case "context":
        return h("div", { class: "row context", style }, row.name);
      case "lazy":
        return h("div", { class: "row lazy", style, onclick: () => this.model.loadContext(row.context) },
          h("span", { class: "link" }, "Load variables"), " (can be slow)");
      case "loading":
        return h("div", { class: "row note", style }, "Loading…");
      case "error":
        return h("div", { class: "row note error", style }, row.message);
      case "more":
        return h("div", { class: "row note", style }, "… more are not shown");
      case "empty":
        return h("div", { class: "row note", style }, "No matching variables");
      default: {
        const toggle = row.expandable ? () => this.model.toggle(row.path) : null;
        return h("div", { class: `row variable${row.expandable ? " expandable" : ""}${row.expanded ? " expanded" : ""}`, style, "data-path": row.path, onclick: toggle },
          h("span", { class: "twisty" }, row.expandable ? (row.expanded ? "▾" : "▸") : ""),
          h("span", { class: "name" }, row.name),
          row.type ? h("span", { class: "type", title: row.type }, row.type) : null,
          h("span", { class: "value", title: String(row.value) }, clip(row.value)));
      }
    }
  }
}

module.exports = { WorkspacePane, URI };
