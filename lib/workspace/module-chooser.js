// Which module of the REPL the Workspace pane shows: a fixed one ("Main", "Main.Foo") or FOLLOW, the module the
// editor's cursor is in. The pane lives in pulsar-ide-debugger and only knows the generic "choices" a live source
// can offer; attach() gives a ReplWorkspaceSource those (`choices()`, `choice`, `choose(value)`) backed by this.
//
// The choice outlives REPL sessions: it is restored from the package setting and applied to every REPL that
// connects. ModuleFollower calls followTo() as the cursor moves.
const { FOLLOW, chooseExistingModule, candidateFor } = require("./module-follow");

const FOLLOW_LABEL = "Follow editor";

class ModuleChooser {
  constructor({ choice = "Main" } = {}) {
    this.choice = choice || "Main";
    this.source = null;
    this.names = []; // module paths the current REPL has loaded
    this.listeners = new Set(); // any change (choice or source)
    this.chooseListeners = new Set(); // choices the user made, to save them
    this.loading = null;
  }

  onDidChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Called when the user picks something in the pane; `fn(choice)` lets the package remember it.
  onDidChooseModule(fn) {
    this.chooseListeners.add(fn);
    return () => this.chooseListeners.delete(fn);
  }

  emit() {
    for (const fn of [...this.listeners]) fn();
    // The pane redraws when the source announces a state; the choice is part of what it draws.
    if (this.source && this.source.state) this.source.emit("state", this.source.state);
  }

  get canChoose() {
    return !!this.source && typeof this.source.modules === "function" && typeof this.source.setModule === "function";
  }

  get following() {
    return this.canChoose && this.choice === FOLLOW;
  }

  // Give a REPL source the pane's choice menu, and show the chosen module in it.
  attach(source) {
    this.source = source || null;
    this.names = [];
    if (!this.canChoose) return source;
    const chooser = this;
    source.choices = () => chooser.choices();
    source.choose = (value) => chooser.choose(value);
    Object.defineProperty(source, "choice", { configurable: true, enumerable: true, get: () => chooser.choice });
    this.apply();
    this.emit();
    this.loadModules();
    return source;
  }

  detach(source) {
    if (source && source !== this.source) return;
    this.source = null;
    this.names = [];
    this.emit();
  }

  // Restoring a saved choice: switch without announcing it.
  setChoice(choice) {
    this.choice = choice || "Main";
    this.apply();
    this.emit();
  }

  // The user picked something.
  choose(choice) {
    this.setChoice(choice);
    for (const fn of [...this.chooseListeners]) fn(this.choice);
  }

  apply() {
    if (!this.canChoose || this.choice === FOLLOW) return;
    if (this.source.module !== this.choice) this.source.setModule(this.choice);
  }

  async loadModules() {
    if (!this.canChoose) return this.names;
    if (this.loading) return this.loading;
    const source = this.source;
    this.loading = (async () => {
      try {
        const names = await source.modules();
        if (source === this.source) this.names = names;
      } catch (e) {
        /* keep the list we had */
      } finally {
        this.loading = null;
      }
      return this.names;
    })();
    return this.loading;
  }

  // For the pane's menu: Follow editor, then the REPL's modules (and the chosen one, even if not loaded yet).
  async choices() {
    const names = await this.loadModules();
    const list = [...names];
    if (this.choice !== FOLLOW && !list.includes(this.choice)) list.push(this.choice);
    return [{ value: FOLLOW, label: FOLLOW_LABEL }, ...list.map((n) => ({ value: n, label: n }))];
  }

  // The editor's cursor is in `parts` (["Foo", "Bar"], [] at top level): show the deepest such module the REPL has.
  async followTo(parts) {
    if (!this.following) return;
    const wanted = candidateFor(parts);
    if (!this.names.includes(wanted)) await this.loadModules();
    if (!this.following) return;
    const target = chooseExistingModule(this.names, parts);
    if (this.source.module !== target) await this.source.setModule(target);
  }
}

module.exports = { ModuleChooser, FOLLOW, FOLLOW_LABEL };
