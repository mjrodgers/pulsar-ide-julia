// A thin line above each cell marker (`##`, `#---`, `# %%`) in Julia files, so the cells that Send Cell runs can be
// seen (as hydrogen-next does). Line decorations on a marker layer of each editor, updated when typing pauses.
const { isCellMarker } = require("./repl");

const CLASS = "pulsar-ide-julia-cell-separator";

class CellSeparators {
  // workspace: atom.workspace; isJulia(editor); enabled(): the setting
  constructor({ workspace, isJulia, enabled = () => true }) {
    this.workspace = workspace;
    this.isJulia = isJulia;
    this.enabled = enabled;
    this.tracked = new Map(); // editor -> {layer, subscriptions}
    this.observers = [];
    this.editorSubscriptions = new Map(); // editor -> [grammar, destroyed]
  }

  start() {
    this.observers.push(this.workspace.observeTextEditors((editor) => {
      this.check(editor);
      const grammar = editor.onDidChangeGrammar(() => this.check(editor));
      const destroyed = editor.onDidDestroy(() => {
        grammar.dispose();
        destroyed.dispose();
        this.editorSubscriptions.delete(editor);
        this.untrack(editor);
      });
      this.editorSubscriptions.set(editor, [grammar, destroyed]);
    }));
  }

  // Applies the setting to every open editor.
  refreshAll() {
    for (const editor of this.workspace.getTextEditors()) this.check(editor);
  }

  check(editor) {
    const want = this.enabled() && this.isJulia(editor);
    if (want && !this.tracked.has(editor)) this.track(editor);
    else if (!want && this.tracked.has(editor)) this.untrack(editor);
  }

  track(editor) {
    const layer = editor.addMarkerLayer();
    editor.decorateMarkerLayer(layer, { type: "line", class: CLASS });
    const changes = editor.getBuffer().onDidStopChanging(() => this.update(editor));
    this.tracked.set(editor, { layer, changes });
    this.update(editor);
  }

  untrack(editor) {
    const t = this.tracked.get(editor);
    if (!t) return;
    this.tracked.delete(editor);
    t.changes.dispose();
    t.layer.destroy();
  }

  update(editor) {
    const t = this.tracked.get(editor);
    if (!t) return;
    t.layer.clear();
    const lines = editor.getBuffer().getLines();
    // The first line of the file needs no line above it.
    for (let row = 1; row < lines.length; row++) {
      if (isCellMarker(lines[row])) t.layer.markBufferRange([[row, 0], [row, 0]], { invalidate: "never" });
    }
  }

  rows(editor) {
    const t = this.tracked.get(editor);
    return t ? t.layer.getMarkers().map((m) => m.getBufferRange().start.row) : [];
  }

  dispose() {
    for (const o of this.observers) o.dispose();
    this.observers = [];
    for (const subs of this.editorSubscriptions.values()) subs.forEach((s) => s.dispose());
    this.editorSubscriptions.clear();
    for (const editor of [...this.tracked.keys()]) this.untrack(editor);
  }
}

module.exports = { CellSeparators, CLASS };
