// Source breakpoints, owned by the editor side. Lines are 1-based. Debug adapters want the complete list
// per file every time, so the controller just sends `list(file)` after each change.
class BreakpointStore {
  constructor() {
    this.byFile = new Map(); // file -> Map(line -> {line, condition})
    this.listeners = new Set();
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(file) {
    for (const l of [...this.listeners]) l(file);
  }

  list(file) {
    const m = this.byFile.get(file);
    return m ? [...m.values()].sort((a, b) => a.line - b.line).map((b) => ({ ...b })) : [];
  }

  has(file, line) {
    const m = this.byFile.get(file);
    return !!m && m.has(line);
  }

  files() {
    return [...this.byFile.keys()].filter((f) => this.byFile.get(f).size > 0);
  }

  // Map<file, [{line, condition}]> of the files that have any.
  all() {
    return new Map(this.files().map((f) => [f, this.list(f)]));
  }

  // Returns true when a breakpoint now exists at the line.
  toggle(file, line) {
    let m = this.byFile.get(file);
    if (!m) this.byFile.set(file, (m = new Map()));
    const added = !m.has(line);
    if (added) m.set(line, { line, condition: "" });
    else m.delete(line);
    this.emit(file);
    return added;
  }

  setCondition(file, line, condition) {
    const m = this.byFile.get(file);
    if (!m || !m.has(line)) return false;
    m.get(line).condition = condition || "";
    this.emit(file);
    return true;
  }

  // The text above a breakpoint changed and its marker moved. If another one is already there, they merge.
  moveLine(file, from, to) {
    const m = this.byFile.get(file);
    if (!m || from === to || !m.has(from)) return;
    const bp = m.get(from);
    m.delete(from);
    if (!m.has(to)) m.set(to, { ...bp, line: to });
    this.emit(file);
  }

  clear(file) {
    if (file) this.byFile.delete(file);
    else this.byFile.clear();
    this.emit(file);
  }
}

module.exports = { BreakpointStore };
