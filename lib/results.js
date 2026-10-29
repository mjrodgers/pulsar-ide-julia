// Inline results: the result of code sent to the REPL, shown under that code in the editor (as Hydrogen and Juno do).
//
// The REPL's helper (julia/workspace.jl) evaluates the code and, when asked, reports how it went:
//   {event: "result", id, ms, kind: "value" | "image" | "nothing" | "error", text, full?, mime?, file?, line?}
// `begin()` puts a "running" line under the code as soon as it is sent; `report()` fills it in. A result goes away
// when the code is edited, when new code ending on the same line is sent, or with its × (or Clear Results).
const { createH } = require("./workspace/dom");

// "12 ms", "1.25 s", "2 min 5 s", "1 h 3 min".
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  return `${Math.floor(ms / 3600000)} h ${Math.floor((ms % 3600000) / 60000)} min`;
}

// The last row a range really covers (a range ending at column 0 of the next row ends on the row before).
function lastRow(range) {
  const { start, end } = range;
  return end.column === 0 && end.row > start.row ? end.row - 1 : end.row;
}

const toRange = (r) => (Array.isArray(r)
  ? { start: { row: r[0][0], column: r[0][1] }, end: { row: r[1][0], column: r[1][1] } }
  : { start: { row: r.start.row, column: r.start.column }, end: { row: r.end.row, column: r.end.column } });

class ResultView {
  constructor(owner, { editor, range, h }) {
    this.owner = owner;
    this.editor = editor;
    this.h = h;
    this.row = lastRow(range);
    this.expanded = false;
    this.message = null;
    // The whole code, so that editing any of it takes the result away (edits at its edges do not).
    const end = { row: this.row, column: editor.lineTextForBufferRow(this.row).length };
    this.marker = editor.markBufferRange([[range.start.row, range.start.column], [end.row, end.column]], { invalidate: "inside" });
    this.element = h("div", { class: "pulsar-ide-julia-result pending" });
    const indent = Math.max(0, editor.indentationForBufferRow(range.start.row) * editor.getTabLength());
    if (indent && this.element.style) this.element.style.marginLeft = `${indent}ch`;
    this.decoration = editor.decorateMarker(this.marker, { type: "block", position: "after", item: this.element });
    this.markerSubscription = this.marker.onDidChange(({ isValid }) => { if (!isValid) this.destroy(); });
    this.render();
  }

  report(message) {
    this.message = message;
    this.render();
  }

  toggle() {
    if (!this.message || !this.message.full) return;
    this.expanded = !this.expanded;
    this.render();
  }

  render() {
    const { h } = this;
    const m = this.message;
    const close = h("span", {
      class: "result-close icon icon-x",
      title: "Dismiss",
      onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.destroy(); },
    });
    if (!m) {
      this.element.className = "pulsar-ide-julia-result pending";
      h.replaceChildren(this.element, [
        h("div", { class: "result-header" }, h("span", { class: "loading loading-spinner-tiny inline-block" }), h("span", { class: "result-text" }, "running…"), close),
      ]);
      return;
    }
    const kind = ["value", "image", "nothing", "error"].includes(m.kind) ? m.kind : "value";
    const expandable = !!m.full;
    this.element.className = `pulsar-ide-julia-result ${kind}${expandable ? " expandable" : ""}${this.expanded ? " expanded" : ""}`;
    const icon = kind === "error" ? "icon-alert" : kind === "nothing" ? "icon-check" : expandable ? (this.expanded ? "icon-chevron-down" : "icon-chevron-right") : "icon-primitive-dot";
    let text = kind === "nothing" ? "" : String(m.text || "");
    if (kind === "error" && m.line > 0) text += `  (line ${m.line})`;
    const header = h("div", {
      class: "result-header",
      title: expandable ? (this.expanded ? "Click to show less" : "Click to show all") : null,
      onclick: () => this.toggle(),
    },
    h("span", { class: `result-icon icon ${icon}` }),
    text ? h("span", { class: "result-text" }, text) : null,
    m.ms !== undefined ? h("span", { class: "result-time" }, formatDuration(m.ms)) : null,
    close);
    const parts = [header];
    if (kind === "image") {
      const src = this.owner.imageSource(m);
      if (src) {
        parts.push(h("img", {
          class: "result-image",
          src,
          title: "Click to open the image in a tab",
          onclick: () => this.owner.openImage(m),
        }));
      }
    }
    if (expandable && this.expanded) parts.push(h("pre", { class: "result-full" }, String(m.full)));
    h.replaceChildren(this.element, parts);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.markerSubscription) this.markerSubscription.dispose();
    try { this.marker.destroy(); } catch (e) { /* the editor is gone */ }
    this.owner.forget(this);
  }
}

class InlineResults {
  // deps: document, readFile(path) -> Buffer, openFile(path)
  constructor({ document = global.document, readFile = require("fs").readFileSync, openFile = () => {} } = {}) {
    this.h = createH(document);
    this.readFile = readFile;
    this.openFile = openFile;
    this.views = new Map(); // id -> ResultView
    this.early = new Map(); // results that arrived before begin() (the code ran very fast)
    this.editorSubscriptions = new Map();
  }

  // Code with request id `id` was sent from `range` of `editor`.
  begin(id, editor, range) {
    const r = toRange(range);
    const row = lastRow(r);
    for (const view of [...this.views.values()]) if (view.editor === editor && view.row === row) view.destroy();
    const view = new ResultView(this, { editor, range: r, h: this.h });
    view.id = id;
    this.views.set(id, view);
    if (!this.editorSubscriptions.has(editor) && typeof editor.onDidDestroy === "function") {
      this.editorSubscriptions.set(editor, editor.onDidDestroy(() => this.clear(editor)));
    }
    const early = this.early.get(id);
    if (early) { this.early.delete(id); view.report(early); }
    return view;
  }

  report(message) {
    if (!message || message.id === undefined) return;
    const view = this.views.get(message.id);
    if (view) view.report(message);
    else {
      this.early.set(message.id, message);
      if (this.early.size > 50) this.early.delete(this.early.keys().next().value);
    }
  }

  // Sending failed or was typed instead: no result will come.
  cancel(id) {
    const view = this.views.get(id);
    if (view) view.destroy();
  }

  imageSource(m) {
    if (!m.file) return null;
    try {
      const data = this.readFile(m.file);
      return `data:${m.mime || "image/png"};base64,${Buffer.from(data).toString("base64")}`;
    } catch (e) {
      return null;
    }
  }

  openImage(m) {
    if (m.file) this.openFile(m.file);
  }

  forget(view) {
    if (this.views.get(view.id) === view) this.views.delete(view.id);
  }

  // Every result in `editor`, or everywhere.
  clear(editor = null) {
    for (const view of [...this.views.values()]) if (!editor || view.editor === editor) view.destroy();
    if (editor && this.editorSubscriptions.has(editor)) {
      this.editorSubscriptions.get(editor).dispose();
      this.editorSubscriptions.delete(editor);
    }
  }

  dispose() {
    this.clear();
    for (const s of this.editorSubscriptions.values()) s.dispose();
    this.editorSubscriptions.clear();
    this.early.clear();
  }
}

module.exports = { InlineResults, formatDuration, lastRow };
