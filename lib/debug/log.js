// What the debuggee and the adapter print, kept so the output pane can be opened at any time.
const MAX_CHARS = 400000;

class OutputLog {
  constructor() {
    this.chunks = []; // {category, text}
    this.size = 0;
    this.listeners = new Set();
  }

  onDidAppend(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(text, category = "stdout") {
    if (!text) return;
    const chunk = { category, text: String(text) };
    this.chunks.push(chunk);
    this.size += chunk.text.length;
    while (this.size > MAX_CHARS && this.chunks.length > 1) this.size -= this.chunks.shift().text.length;
    for (const l of [...this.listeners]) l(chunk);
  }

  // A separator line, e.g. "— debugging a.jl —", shown in a different style.
  note(text) {
    this.append(`${text}\n`, "note");
  }

  clear() {
    this.chunks = [];
    this.size = 0;
    for (const l of [...this.listeners]) l(null);
  }

  text() {
    return this.chunks.map((c) => c.text).join("");
  }
}

module.exports = { OutputLog };
