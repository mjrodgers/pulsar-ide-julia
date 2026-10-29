// The data behind the workspace pane, with no DOM and no Pulsar in it.
//
// It follows a DapSession (anything with `state`, `on("state")`, `loadVariables`, `loadScope`
// and `selectFrame`) and turns its state into a flat list of rows for the pane to draw: one header per
// scope, then the variables, with expanded variables followed by their children.
//
// What the user has expanded is remembered by *path* (scope name, then variable names), not by the
// adapter's variable references, because those references are only valid for one stop. After every stop the
// model re-fetches the children of everything still expanded, so a stepping session keeps its
// view of `v` open while the numbers inside it change.

const { FOLLOW, chooseExistingModule, candidateFor } = require("./module-follow");

const SEP = "\u001f";
const pathOf = (...names) => names.join(SEP);

// Case-insensitive subsequence match, the same loose matching people expect from a fuzzy filter.
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = String(text).toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

const basename = (file) => String(file || "").split(/[\\/]/).pop();

class WorkspaceModel {
  constructor() {
    this.session = null;
    this.filter = "";
    this.expanded = new Set(); // paths, kept across stops and across sessions
    this.children = new Map(); // path -> {status: "loading"|"loaded"|"error", items, message}
    this.generation = 0; // bumped whenever the adapter's variable references stop being valid
    this.lastContexts = null;
    this.listeners = new Set();
    this.unsubscribe = null;
    this.moduleChoice = "Main"; // a module path, or FOLLOW
    this.moduleNames = [];
    this.moduleListeners = new Set();
    this.loadingModules = null;
  }

  // --- which module of the REPL is shown ---------------------------------------------------------
  // Only a REPL source can switch modules (it has `modules()` and `setModule()`); a debug session shows its frame.
  get canChooseModule() {
    return !!this.session && typeof this.session.modules === "function" && typeof this.session.setModule === "function";
  }

  get following() {
    return this.canChooseModule && this.moduleChoice === FOLLOW;
  }

  // Called when the user picks something; `fn(choice)` lets the package remember it.
  onDidChooseModule(fn) {
    this.moduleListeners.add(fn);
    return () => this.moduleListeners.delete(fn);
  }

  // Sets the choice without announcing it (restoring a saved one). Switches the REPL's watched module if needed.
  setModuleChoice(choice) {
    this.moduleChoice = choice || "Main";
    this.applyChoice();
    this.emit();
  }

  chooseModule(choice) {
    this.setModuleChoice(choice);
    for (const fn of [...this.moduleListeners]) fn(this.moduleChoice);
  }

  applyChoice() {
    if (!this.canChooseModule || this.moduleChoice === FOLLOW) return;
    if (this.session.module !== this.moduleChoice) this.session.setModule(this.moduleChoice);
  }

  async loadModules() {
    if (!this.canChooseModule) return;
    if (this.loadingModules) return this.loadingModules;
    const session = this.session;
    this.loadingModules = (async () => {
      try {
        const names = await session.modules();
        if (session === this.session) {
          this.moduleNames = names;
          this.emit();
        }
      } catch (e) {
        /* the pane keeps the list it had */
      } finally {
        this.loadingModules = null;
      }
    })();
    return this.loadingModules;
  }

  // The editor's cursor is in `parts` (["Foo", "Bar"], [] at top level): show the deepest such module the REPL has.
  async followTo(parts) {
    if (!this.following) return;
    const wanted = candidateFor(parts);
    if (!this.moduleNames.includes(wanted)) await this.loadModules();
    if (!this.following) return;
    const target = chooseExistingModule(this.moduleNames, parts);
    if (this.session.module !== target) await this.session.setModule(target);
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const l of [...this.listeners]) l();
  }

  setSession(session) {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.session = session || null;
    this.moduleNames = [];
    this.generation++;
    this.children.clear();
    this.lastContexts = session ? session.state.contexts : null;
    if (session) {
      const handler = () => this.onSessionState();
      session.on("state", handler);
      this.unsubscribe = () => session.removeListener("state", handler);
    }
    this.applyChoice();
    this.emit();
    this.loadModules();
  }

  destroy() {
    this.setSession(null);
    this.listeners.clear();
    this.moduleListeners.clear();
  }

  onSessionState() {
    const contexts = this.session.state.contexts;
    if (contexts !== this.lastContexts) {
      this.lastContexts = contexts;
      this.generation++;
      this.children.clear();
      this.emit();
      this.refreshExpanded();
      if (this.canChooseModule) this.loadModules();
    } else {
      this.emit();
    }
  }

  setFilter(text) {
    this.filter = text || "";
    this.emit();
  }

  // --- what to show ----------------------------------------------------------------------------
  get state() {
    return this.session ? this.session.state : null;
  }

  // True while the rows on screen belong to an earlier stop (or the program is running).
  get stale() {
    const s = this.state;
    return !!s && (s.status === "running" || s.status === "starting" || !!s.loading || !!s.busy);
  }

  // A live REPL source can be asked to read its module again.
  get canRefresh() {
    return !!this.session && typeof this.session.refresh === "function";
  }

  async refresh() {
    if (this.canRefresh) await this.session.refresh();
  }

  statusText() {
    const s = this.state;
    if (!s) return "No debug session.";
    switch (s.status) {
      case "starting": return "Starting the debugger…";
      case "running": return "Running…";
      case "live": {
        const where = `REPL: ${(s.contexts[0] && s.contexts[0].name) || "Main"}`;
        if (s.busy) return `${where} (running; values as they were before)`;
        if (s.problem) return `${where} (could not read it: ${s.problem})`;
        return where;
      }
      case "ended": return "The debug session has ended.";
      case "stopped": {
        const f = s.frames[0];
        const where = f ? ` in ${f.name}${f.file ? ` at ${basename(f.file)}:${f.line}` : ""}` : "";
        return `Stopped (${s.reason || "paused"})${where}${s.loading ? "…" : ""}`;
      }
      default: return "No debug session.";
    }
  }

  frames() {
    const s = this.state;
    return s ? s.frames : [];
  }

  frameId() {
    const s = this.state;
    return s ? s.frameId : undefined;
  }

  rows() {
    const out = [];
    const s = this.state;
    if (!s) return out;
    for (const ctx of s.contexts) {
      const path = pathOf(ctx.name);
      out.push({ kind: "context", depth: 0, path, name: ctx.name });
      if (ctx.lazy) {
        out.push({ kind: "lazy", depth: 1, path: pathOf(ctx.name, "#lazy"), context: ctx });
        continue;
      }
      const shown = ctx.items.filter((v) => fuzzyMatch(this.filter, v.name));
      for (const item of shown) this.pushVariable(out, item, 1, pathOf(ctx.name, item.name));
      if (!this.filter && ctx.items.length && ctx.items[ctx.items.length - 1].truncated) {
        out.push({ kind: "more", depth: 1, path: pathOf(ctx.name, "#more") });
      }
      if (this.filter && shown.length === 0) out.push({ kind: "empty", depth: 1, path: pathOf(ctx.name, "#empty") });
    }
    return out;
  }

  pushVariable(out, item, depth, path) {
    const expandable = item.ref > 0;
    const expanded = expandable && this.expanded.has(path);
    out.push({ kind: "variable", depth, path, name: item.name, value: item.value, type: item.type, expandable, expanded, item });
    if (!expanded) return;
    const c = this.children.get(path);
    if (!c || c.status === "loading") {
      out.push({ kind: "loading", depth: depth + 1, path: path + SEP + "#loading" });
    } else if (c.status === "error") {
      out.push({ kind: "error", depth: depth + 1, path: path + SEP + "#error", message: c.message });
    } else {
      for (const child of c.items) this.pushVariable(out, child, depth + 1, path + SEP + child.name);
      if (c.items.length && c.items[c.items.length - 1].truncated) out.push({ kind: "more", depth: depth + 1, path: path + SEP + "#more" });
    }
  }

  // --- expanding -------------------------------------------------------------------------------
  isExpanded(path) {
    return this.expanded.has(path);
  }

  async toggle(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.emit();
      return;
    }
    this.expanded.add(path);
    this.emit();
    await this.refreshExpanded();
  }

  // Expanded variables (visible or not) whose children have not been fetched for this stop.
  unloaded() {
    const s = this.state;
    const found = [];
    if (!s) return found;
    const visit = (item, path) => {
      if (!(item.ref > 0) || !this.expanded.has(path)) return;
      const c = this.children.get(path);
      if (!c) found.push({ path, item });
      else if (c.status === "loaded") for (const child of c.items) visit(child, path + SEP + child.name);
    };
    for (const ctx of s.contexts) if (!ctx.lazy) for (const item of ctx.items) visit(item, pathOf(ctx.name, item.name));
    return found;
  }

  async refreshExpanded() {
    const generation = this.generation;
    for (;;) {
      if (generation !== this.generation) return;
      const pending = this.unloaded();
      if (pending.length === 0) return;
      for (const { path } of pending) this.children.set(path, { status: "loading", items: [] });
      this.emit();
      await Promise.all(pending.map(async ({ path, item }) => {
        let entry;
        try {
          entry = { status: "loaded", items: await this.session.loadVariables(item.ref) };
        } catch (e) {
          entry = { status: "error", items: [], message: e.message || String(e) };
        }
        if (generation === this.generation) this.children.set(path, entry);
      }));
      if (generation === this.generation) this.emit();
    }
  }

  // --- scopes and frames -----------------------------------------------------------------------
  async loadContext(context) {
    if (!this.session) return;
    await this.session.loadScope(context.ref);
  }

  async selectFrame(id) {
    if (!this.session) return;
    await this.session.selectFrame(id);
  }
}

module.exports = { WorkspaceModel, fuzzyMatch, pathOf, SEP, FOLLOW };
