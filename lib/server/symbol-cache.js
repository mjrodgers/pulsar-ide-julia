// The outline, Go to Symbol, Follow editor and sending code all ask JETLS for a file's document symbols, often for the
// same text (the outline after every pause in typing, Follow editor after every cursor move that crosses a line,
// sending before every send). One answer per version of the text is enough: a request for an editor whose text has
// not changed since the last one shares that answer (or the request still on its way) instead of asking JETLS again.
//
// An answer is dropped as soon as the buffer changes or the file is renamed; failures and `null` (no server yet) are
// not kept.
class SymbolCache {
  // fetch(editor) -> Promise of the server's reply
  constructor(fetch) {
    this.fetch = fetch;
    this.entries = new Map(); // editor -> {promise, subscriptions}
  }

  get(editor) {
    let entry = this.entries.get(editor);
    if (entry && entry.promise) return entry.promise;
    if (!entry) entry = this.track(editor);
    const promise = Promise.resolve().then(() => this.fetch(editor));
    entry.promise = promise;
    const forget = () => { if (entry.promise === promise) entry.promise = null; };
    promise.then((reply) => { if (reply == null) forget(); }, forget);
    return promise;
  }

  track(editor) {
    const entry = { promise: null, subscriptions: [] };
    const drop = () => { entry.promise = null; };
    const buffer = editor.getBuffer && editor.getBuffer();
    if (buffer && buffer.onDidChange) entry.subscriptions.push(buffer.onDidChange(drop));
    if (editor.onDidChangePath) entry.subscriptions.push(editor.onDidChangePath(drop));
    if (editor.onDidDestroy) entry.subscriptions.push(editor.onDidDestroy(() => this.untrack(editor)));
    this.entries.set(editor, entry);
    return entry;
  }

  untrack(editor) {
    const entry = this.entries.get(editor);
    if (!entry) return;
    this.entries.delete(editor);
    entry.subscriptions.forEach((s) => s && s.dispose && s.dispose());
  }

  // After a server restart: the new server may answer differently.
  clear() {
    for (const entry of this.entries.values()) entry.promise = null;
  }

  dispose() {
    for (const editor of [...this.entries.keys()]) this.untrack(editor);
  }
}

module.exports = { SymbolCache };
