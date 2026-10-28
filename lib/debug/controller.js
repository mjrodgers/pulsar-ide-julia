// Owns one debug session at a time: starts the adapter, connects the DAP session to the workspace model,
// the breakpoint store and the editor UI, and implements the commands.
//
// The editor-specific parts (gutter dots, current-line marker, opening panes) live behind `ui` so this class
// can run in plain Node against a fake adapter.
const { setTimeout, clearTimeout } = require("timers"); // real timers even under a mock clock
const { DapClient } = require("../dap/client");
const { DapSession } = require("../dap/session");
const { WorkspaceModel } = require("../workspace/model");
const { BreakpointStore } = require("./store");
const { OutputLog } = require("./log");
const { currentLocation } = require("./location");
const { buildLaunchArguments } = require("./launch");
const { launchAdapter, explainLaunchFailure } = require("./adapter-process");

const noop = () => {};
const quietLogger = { debug: noop, info: noop, warn: noop, error: noop };

class DebugController {
  constructor({ setting, notifications, ui, getActiveEditor, launch = launchAdapter, logger = quietLogger } = {}) {
    this.setting = setting;
    this.notifications = notifications;
    this.ui = ui;
    this.getActiveEditor = getActiveEditor || (() => null);
    this.launch = launch;
    this.logger = logger;

    this.store = new BreakpointStore();
    this.log = new OutputLog();
    this.model = new WorkspaceModel();
    this.session = null;
    this.child = null;
    this.replSource = null; // what the workspace pane follows while nothing is being debugged
    this.starting = false;
    this.logHasOutput = false;

    this.unsubscribeStore = this.store.onDidChange((file) => { if (file) this.pushBreakpoints(file); });
    this.unsubscribeLog = this.log.onDidAppend((chunk) => {
      if (chunk && chunk.category !== "note" && !this.logHasOutput) {
        this.logHasOutput = true;
        if (this.setting("debugger.openOutput")) this.ui.openOutput();
      }
    });
  }

  notify(kind, message, options) {
    this.notifications[kind](`Julia debugger: ${message}`, options);
  }

  get active() {
    return !!this.session && this.session.state.status !== "ended";
  }

  get stopped() {
    return !!this.session && this.session.state.status === "stopped";
  }

  // The workspace pane follows the debugger while a session is active, and the REPL otherwise.
  setReplSource(source) {
    this.replSource = source || null;
    if (!this.active) this.model.setSession(this.replSource);
  }

  commandTable() {
    const withEditor = (fn) => () => fn(this.getActiveEditor());
    return {
      "debug-start-or-continue": withEditor((e) => this.startOrContinue(e)),
      "debug-file": withEditor((e) => this.debugFile(e)),
      "debug-continue": () => this.step("continue"),
      "debug-step-over": () => this.step("stepOver"),
      "debug-step-in": () => this.step("stepIn"),
      "debug-step-out": () => this.step("stepOut"),
      "debug-stop": () => this.stop(),
      "toggle-breakpoint": withEditor((e) => this.toggleBreakpoint(e)),
      "clear-breakpoints": () => this.clearBreakpoints(),
      "open-workspace": () => this.ui.openWorkspace({ focus: true }),
      "show-debug-output": () => this.ui.openOutput({ focus: true }),
    };
  }

  // --- starting ----------------------------------------------------------------------------------
  async startOrContinue(editor) {
    if (this.stopped) return this.step("continue");
    return this.debugFile(editor);
  }

  async debugFile(editor) {
    if (this.starting || this.active) {
      this.notify("addInfo", "a debug session is already running. Stop it first (debug-stop).");
      return false;
    }
    if (!editor || !editor.getPath()) {
      this.notify("addWarning", "open a saved Julia file to debug.");
      return false;
    }
    const file = editor.getPath();
    this.starting = true;
    let session = null;
    let child = null;
    try {
      if (editor.isModified && editor.isModified()) await editor.save();

      const launchArgs = buildLaunchArguments({
        file,
        stopOnEntry: this.setting("debugger.stopOnEntry"),
        programArgs: this.setting("debugger.programArguments"),
        compiledMode: this.setting("debugger.compiledMode"),
        compiledModules: this.setting("debugger.compiledModules"),
        extraJson: this.setting("debugger.launchArgumentsJson"),
      });
      if (launchArgs.error) this.notify("addWarning", launchArgs.error);

      const settings = {
        juliaPath: this.setting("debugger.juliaPath"),
        threads: this.setting("debugger.threads"),
        environment: this.setting("debugger.environment"),
        flags: this.setting("debugger.flags"),
      };
      this.log.note(`Debugging ${file}`);
      if (this.setting("debugger.openWorkspace")) this.ui.openWorkspace();

      let socket;
      try {
        ({ socket, child } = await this.launch({ file, settings, log: this.log }));
      } catch (e) {
        this.notify("addError", explainLaunchFailure(e, settings), { detail: e.stderrTail || undefined, dismissable: true });
        this.log.note(`Could not start the debug adapter: ${e.message}`);
        return false;
      }

      session = new DapSession(new DapClient(socket), { logger: this.logger });
      this.attach(session, child);
      await session.start({
        request: "launch",
        args: launchArgs.args,
        breakpoints: this.store.all(),
        exceptionFilters: this.setting("debugger.exceptionFilters") || [],
      });
      const filters = (session.capabilities.exceptionBreakpointFilters || []).map((f) => f.filter);
      if (filters.length) this.log.note(`Adapter exception filters: ${filters.join(", ")}`);
      return true;
    } catch (e) {
      this.notify("addError", `could not start debugging: ${e.message || e}`, { dismissable: true });
      if (session) await session.stop();
      this.killChild(child);
      return false;
    } finally {
      this.starting = false;
    }
  }

  attach(session, child) {
    this.session = session;
    this.child = child;
    this.model.setSession(session);

    session.on("output", ({ category, text }) => {
      if (category === "telemetry") return;
      this.log.append(text, category === "stderr" || category === "important" ? "stderr" : "stdout");
    });
    session.on("state", (state) => this.ui.showLocation(currentLocation(state)));
    session.on("ended", () => {
      if (this.replSource) this.model.setSession(this.replSource);
      this.ui.showLocation(null);
      this.log.note("Debug session ended");
      this.killChildSoon(child);
    });
    if (child && child.on) {
      child.on("exit", (code, signal) => this.log.note(`Julia exited (${signal || `code ${code}`})`));
    }
  }

  killChild(child) {
    try { if (child && child.kill) child.kill(); } catch (e) { /* already gone */ }
  }

  // Give a program that is shutting down by itself a moment, then make sure it is gone.
  killChildSoon(child) {
    if (!child) return;
    const timer = setTimeout(() => this.killChild(child), 1500);
    if (timer.unref) timer.unref();
    if (child.once) child.once("exit", () => clearTimeout(timer));
  }

  // --- control -----------------------------------------------------------------------------------
  async step(command) {
    if (!this.stopped) {
      this.notify("addInfo", this.active ? "the program is running; wait for it to stop at a breakpoint." : "no debug session. Use \"Debug file\" first.");
      return;
    }
    try {
      await this.session[command]();
    } catch (e) {
      this.notify("addError", `${command} failed: ${e.message || e}`);
    }
  }

  async stop() {
    if (!this.session || !this.active) return;
    const child = this.child;
    await this.session.stop();
    this.killChildSoon(child);
  }

  // --- breakpoints -------------------------------------------------------------------------------
  toggleBreakpoint(editor) {
    if (!editor || !editor.getPath()) {
      this.notify("addWarning", "save the file before setting breakpoints.");
      return;
    }
    this.store.toggle(editor.getPath(), editor.getCursorBufferPosition().row + 1);
  }

  clearBreakpoints() {
    const files = this.store.files();
    this.store.clear();
    for (const file of files) this.pushBreakpoints(file);
  }

  pushBreakpoints(file) {
    if (!this.session || !this.active || this.session.state.status === "starting") return;
    this.session.setBreakpoints(file, this.store.list(file)).catch((e) => this.logger.warn("Could not update breakpoints", e));
  }

  // --- shutdown ----------------------------------------------------------------------------------
  async destroy() {
    this.unsubscribeStore();
    this.unsubscribeLog();
    const child = this.child;
    try { if (this.session && this.active) await this.session.stop(); } catch (e) { /* closing anyway */ }
    this.killChild(child);
    this.model.destroy();
  }
}

module.exports = { DebugController };
