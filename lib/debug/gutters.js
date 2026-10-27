// Breakpoint dots in a gutter next to the line numbers of Julia editors, kept in step with a BreakpointStore.
// Pulsar-only (uses editors, gutters and markers).
const GUTTER = "pulsar-ide-julia-breakpoints";

class EditorBreakpoints {
  constructor(editor, store, doc) {
    this.editor = editor;
    this.store = store;
    this.doc = doc;
    this.entries = new Map(); // line -> {line, marker, decoration, element}
    this.gutter = editor.addGutter({ name: GUTTER, priority: -100 });
    this.onClick = (event) => this.handleClick(event);
    editor.getElement().addEventListener("click", this.onClick);
    this.refresh();
  }

  get path() { return this.editor.getPath(); }

  handleClick(event) {
    const target = event.target;
    if (!target || !target.closest || !target.closest(`.gutter[gutter-name="${GUTTER}"]`)) return;
    if (!this.path) {
      atom.notifications.addWarning("Julia debugger: save the file before setting breakpoints.");
      return;
    }
    const screen = this.editor.component.screenPositionForMouseEvent(event);
    const row = this.editor.bufferPositionForScreenPosition(screen).row;
    this.store.toggle(this.path, row + 1);
  }

  // Make the dots match the store.
  refresh() {
    if (!this.path) return;
    const wanted = new Map(this.store.list(this.path).map((b) => [b.line, b]));
    for (const [line, entry] of [...this.entries]) {
      if (!wanted.has(line)) this.remove(entry);
    }
    for (const [line, bp] of wanted) {
      const entry = this.entries.get(line) || this.add(line);
      entry.element.classList.toggle("conditional", !!bp.condition);
      entry.element.title = bp.condition ? `Breakpoint, only when ${bp.condition}` : "Breakpoint";
    }
  }

  add(line) {
    const marker = this.editor.markBufferRange([[line - 1, 0], [line - 1, 0]], { invalidate: "never" });
    const element = this.doc.createElement("span");
    element.className = "pulsar-ide-julia-bp";
    const decoration = this.gutter.decorateMarker(marker, { item: element });
    const entry = { line, marker, decoration, element };
    marker.onDidChange((event) => {
      const row = event.newHeadBufferPosition.row + 1;
      if (row === entry.line || !this.entries.has(entry.line)) return;
      const from = entry.line;
      this.entries.delete(from);
      if (this.entries.has(row)) {
        this.remove(entry); // two breakpoints met on one line
      } else {
        entry.line = row;
        this.entries.set(row, entry);
      }
      this.store.moveLine(this.path, from, row);
    });
    this.entries.set(line, entry);
    return entry;
  }

  remove(entry) {
    this.entries.delete(entry.line);
    try { entry.decoration.destroy(); } catch (e) { /* editor going away */ }
    try { entry.marker.destroy(); } catch (e) { /* editor going away */ }
  }

  destroy() {
    this.editor.getElement().removeEventListener("click", this.onClick);
    for (const entry of [...this.entries.values()]) this.remove(entry);
    try { this.gutter.destroy(); } catch (e) { /* already destroyed with the editor */ }
  }
}

class BreakpointGutters {
  constructor({ workspace, store, document: doc = global.document }) {
    this.store = store;
    this.doc = doc;
    this.perEditor = new Map();
    this.disposables = [
      workspace.observeTextEditors((editor) => this.observe(editor)),
      { dispose: store.onDidChange((file) => this.refreshFile(file)) },
    ];
  }

  isJulia(editor) {
    const grammar = editor.getGrammar && editor.getGrammar();
    return !!grammar && grammar.scopeName === "source.julia";
  }

  observe(editor) {
    const update = () => {
      const has = this.perEditor.has(editor);
      if (this.isJulia(editor) && !has) this.perEditor.set(editor, new EditorBreakpoints(editor, this.store, this.doc));
      else if (!this.isJulia(editor) && has) this.drop(editor);
    };
    update();
    const grammar = editor.onDidChangeGrammar(update);
    const path = editor.onDidChangePath && editor.onDidChangePath(() => { const e = this.perEditor.get(editor); if (e) e.refresh(); });
    const destroyed = editor.onDidDestroy(() => { this.drop(editor); grammar.dispose(); if (path) path.dispose(); destroyed.dispose(); });
  }

  drop(editor) {
    const e = this.perEditor.get(editor);
    if (!e) return;
    this.perEditor.delete(editor);
    e.destroy();
  }

  refreshFile(file) {
    for (const e of this.perEditor.values()) if (!file || e.path === file) e.refresh();
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    for (const editor of [...this.perEditor.keys()]) this.drop(editor);
  }
}

module.exports = { BreakpointGutters, GUTTER };
