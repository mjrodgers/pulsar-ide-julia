const { AutoLanguageClient } = require("@savetheclocktower/atom-languageclient");
const { CompositeDisposable, Disposable } = require("atom");
const { resolveJetls, buildArgs, buildEnv } = require("./launch");
const { connectViaPipe, withSocketStdio, drainStdout } = require("./channel");
const { createStderrClassifier } = require("./stderr");
const { decorateOutline, describeSymbols, symbolsToOutline, isDocumentSymbolReply } = require("./outline");
const { pathToFileURL } = require("url");
const path = require("path");
const { buildJetlsSettings, parseJsonObject } = require("./settings");
const { ReplController } = require("./repl");
const { DebugController } = require("./debug/controller");
const { PulsarDebugUi } = require("./debug/ui");
const { ReplBridge } = require("./workspace/repl-bridge");
const { Picker } = require("./picker");
const { ModuleFollower } = require("./workspace/module-follow");

const PKG = "pulsar-ide-julia";
const setting = (key) => atom.config.get(`${PKG}.${key}`);

// Changing these needs a new server process; the rest is sent live.
const RESTART_KEYS = ["jetlsPath", "juliaPath", "channel", "threads", "defaultEnvironment", "juliaFlags", "initializationOptionsJson"];

class JuliaLanguageClient extends AutoLanguageClient {
  getGrammarScopes() { return ["source.julia"]; }
  getLanguageName() { return "Julia"; }
  getServerName() { return "JETLS"; }
  getPackageName() { return PKG; }

  activate() {
    super.activate();
    this.replBridge = new ReplBridge({ startupDir: path.join(atom.getConfigDirPath(), PKG) });
    this.picker = new Picker({ workspace: atom.workspace });
    this.repl = new ReplController({
      bridge: this.replBridge,
      setting,
      workspace: atom.workspace,
      commands: atom.commands,
      views: atom.views,
      notifications: atom.notifications,
      fetchSymbols: (editor) => this.fetchDocumentSymbols(editor),
      projectRoot: (file) => atom.project.relativizePath(file)[0],
      pickFolder: () => new Promise((resolve) => atom.pickFolder((paths) => resolve(paths && paths[0] ? paths[0] : null))),
      pick: (items, options) => this.picker.pick(items, options),
    });
    const repl = this.repl;
    this.debugUi = new PulsarDebugUi({ workspace: atom.workspace });
    this.debug = new DebugController({
      setting,
      notifications: atom.notifications,
      ui: this.debugUi,
      getActiveEditor: () => atom.workspace.getActiveTextEditor(),
      logger: console,
    });
    this.debugUi.bind(this.debug);
    // The workspace pane follows the REPL when nothing is being debugged.
    this.replBridge.onDidConnect((source) => this.debug.setReplSource(source));
    this.replBridge.onDidDisconnect(() => this.debug.setReplSource(null));
    // Which module of the REPL the workspace pane shows (a setting, or "Follow editor").
    const model = this.debug.model;
    model.setModuleChoice(setting("workspaceModule"));
    this.follower = new ModuleFollower({
      workspace: atom.workspace,
      fetchSymbols: (editor) => this.fetchDocumentSymbols(editor),
      onPath: (parts) => model.followTo(parts),
      isActive: () => model.following,
    });
    this.follower.watchModel(model);
    this.follower.start();
    const stopChoosing = model.onDidChooseModule((choice) => {
      if (setting("workspaceModule") !== choice) atom.config.set(`${PKG}.workspaceModule`, choice);
    });
    const debugCommands = Object.fromEntries(
      Object.entries(this.debug.commandTable()).map(([name, fn]) => [`${PKG}:${name}`, fn])
    );
    this.subscriptions = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        [`${PKG}:restart-language-server`]: () => this.restartAllServers(),
        [`${PKG}:dump-document-symbols`]: () => this.dumpDocumentSymbols(),
        [`${PKG}:open-repl`]: () => repl.openRepl(),
        [`${PKG}:send-selection-or-definition`]: () => repl.sendSelectionOrDefinition(),
        [`${PKG}:send-selection-or-definition-and-advance`]: () => repl.sendSelectionOrDefinition({ advance: true }),
        [`${PKG}:send-cell`]: () => repl.sendCell(),
        [`${PKG}:send-cell-and-advance`]: () => repl.sendCell({ advance: true }),
        [`${PKG}:send-file`]: () => repl.sendFile(),
        [`${PKG}:activate-environment`]: () => repl.activateEnvironment(),
        [`${PKG}:activate-environment-in-current-folder`]: () => repl.activateEnvironmentInCurrentFolder(),
        [`${PKG}:activate-environment-in-parent-folder`]: () => repl.activateEnvironmentInParentFolder(),
        [`${PKG}:activate-default-environment`]: () => repl.activateDefaultEnvironment(),
        [`${PKG}:select-environment`]: () => repl.selectEnvironment(),
        [`${PKG}:work-in-current-folder`]: () => repl.workInCurrentFolder(),
        [`${PKG}:work-in-project-folder`]: () => repl.workInProjectFolder(),
        [`${PKG}:work-in-home-folder`]: () => repl.workInHomeFolder(),
        [`${PKG}:select-working-folder`]: () => repl.selectWorkingFolder(),
        [`${PKG}:next-cell`]: () => repl.moveToCell(1),
        [`${PKG}:previous-cell`]: () => repl.moveToCell(-1),
        ...debugCommands,
      }),
      new Disposable(stopChoosing),
      atom.config.onDidChange(`${PKG}.workspaceModule`, ({ newValue }) => model.setModuleChoice(newValue)),
      ...RESTART_KEYS.map((key) => atom.config.onDidChange(`${PKG}.${key}`, () => this.offerRestart()))
    );
  }

  deactivate() {
    if (this.subscriptions) this.subscriptions.dispose();
    if (this.follower) this.follower.dispose();
    if (this.picker) this.picker.destroy();
    if (this.replBridge) this.replBridge.dispose();
    if (this.debugUi) this.debugUi.destroy();
    if (this.debug) this.debug.destroy();
    return super.deactivate();
  }

  // --- launching --------------------------------------------------------
  // Called once per project root (the fork starts one server per Pulsar root).
  // JETLS picks the environment per file (nearest Project.toml), so cwd = root
  // is all it needs.
  async startServerProcess(projectPath) {
    const exe = resolveJetls({ configured: setting("jetlsPath") });
    const args = buildArgs({
      threads: setting("threads"),
      defaultEnvironment: setting("defaultEnvironment"),
      juliaFlags: setting("juliaFlags"),
    });
    const options = { cwd: projectPath, env: buildEnv({ juliaPath: setting("juliaPath") }) };

    if (setting("channel") === "stdio") return this.spawn(exe, args, options);

    // In stdio mode, anything the code JETLS loads prints to stdout (a package banner, a
    // stray println) corrupts the protocol stream ("Header must provide a Content-Length
    // property"). A local socket avoids that; it is also the VS Code client's default.
    try {
      const { child, socket } = await connectViaPipe((pipe) =>
        this.spawn(exe, [...args, `--pipe-connect=${pipe}`], options));
      drainStdout(child, (text) => this.logger.debug(`jetls stdout: ${text.trim()}`));
      return withSocketStdio(child, socket);
    } catch (e) {
      atom.notifications.addError("Julia (JETLS): could not connect to the server over a pipe", {
        dismissable: true,
        description: `${(e && e.message) || e}\n\nIf your \`jetls\` is older, set "Communication channel" to \`stdio\` in the package settings.`,
      });
      throw e;
    }
  }

  // --- configuration passthrough ---------------------------------------
  // JETLS *pulls* settings with `workspace/configuration` (section "jetls").
  // The fork handles that for us when we opt in: it advertises the capability,
  // registers the handler, and answers from getRootConfigurationKey() +
  // mapConfigurationObject(). It also pushes didChangeConfiguration whenever
  // anything under that key changes.
  supportsWorkspaceConfiguration() { return true; }
  getRootConfigurationKey() { return PKG; }
  mapConfigurationObject(config) {
    const { settings, errors } = buildJetlsSettings(config);
    errors.forEach((e) => this.warnOnce(e));
    return { jetls: settings };
  }

  // Static options, sent once in `initialize` (changing them needs a restart).
  getInitializeParams(projectPath, lsProcess) {
    const params = super.getInitializeParams(projectPath, lsProcess);
    // The fork reports the SERVER's pid here, but LSP wants the client's: servers watch it
    // and exit when it disappears. JETLS shows it as --clientProcessId=<pid>. With the
    // server's own pid it could never notice that Pulsar had gone away.
    params.processId = process.pid;
    const { value, error } = parseJsonObject(setting("initializationOptionsJson"), "Initialization options");
    if (error) this.warnOnce(error);
    if (Object.keys(value).length) params.initializationOptions = value;
    return params;
  }

  // --- server stderr ------------------------------------------------------
  // JETLS logs ordinary progress to stderr in Julia's log format. The fork would show
  // every line as a warning; sort them by the level Julia printed instead.
  handleServerStderr(stderr, projectPath) {
    this.stderrClassifiers = this.stderrClassifiers || new Map();
    let classify = this.stderrClassifiers.get(projectPath);
    if (!classify) {
      classify = createStderrClassifier();
      this.stderrClassifiers.set(projectPath, classify);
    }
    for (const { level, text } of classify(stderr)) this.logger[level](`stderr ${text}`);
  }

  // --- outline ------------------------------------------------------------
  // The fork's outline adapter keeps only each symbol's name. JETLS puts the full signature
  // in `detail` and lists arguments/locals as children, so ask for the raw symbols and build
  // the outline ourselves (lib/outline.js). Anything unexpected falls back to the adapter,
  // with signatures read from the buffer.
  // The server's raw textDocument/documentSymbol reply for an editor, or null without a connection.
  async fetchDocumentSymbols(editor) {
    const connection = await this.getConnectionForEditor(editor);
    if (!connection || !editor.getPath()) return null;
    return connection.documentSymbol({ textDocument: { uri: pathToFileURL(editor.getPath()).href } });
  }

  async getOutline(editor) {
    try {
      const symbols = await this.fetchDocumentSymbols(editor);
      if (isDocumentSymbolReply(symbols)) {
        return symbolsToOutline(symbols, {
          Point: require("atom").Point,
          showLocals: setting("outlineLocals") === true,
          signatures: setting("outlineSignatures") !== false,
        });
      }
      if (Array.isArray(symbols) && symbols.length === 0) return { outlineTrees: [] };
    } catch (e) {
      this.logger.warn("Could not build the outline from the raw symbols; using the default", e);
    }

    const outline = await super.getOutline(editor);
    if (!outline || setting("outlineSignatures") === false) return outline;
    try {
      return decorateOutline(outline, (row) => editor.lineTextForBufferRow(row));
    } catch (e) {
      this.logger.warn("Could not add signatures to the outline", e);
      return outline;
    }
  }

  // Debugging aid: open a new tab listing exactly what JETLS reports for the active file.
  async dumpDocumentSymbols() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor || !editor.getPath()) return atom.notifications.addWarning("Open a saved Julia file first.");
    try {
      const symbols = await this.fetchDocumentSymbols(editor);
      if (!symbols && !(await this.getConnectionForEditor(editor))) {
        return atom.notifications.addWarning("No JETLS connection for this file yet.");
      }
      const dump = describeSymbols(symbols, (row) => editor.lineTextForBufferRow(row));
      const out = await atom.workspace.open();
      out.setText(dump || "(the server returned no symbols)");
    } catch (e) {
      atom.notifications.addError("Could not fetch document symbols", { detail: String((e && e.message) || e) });
    }
  }

  // --- terminal REPL ----------------------------------------------------
  // Pulsar's built-in `terminal` package (or x-terminal-reloaded) provides a service with
  // open() and run(lines); see lib/repl.js.
  consumeTerminal(service) {
    return this.repl.setService(service);
  }

  consumeLegacyTerminal(service) {
    // platformioIDETerminal 1.1.0 has the same open()/run() calls; only used when the
    // newer `terminal` service is absent.
    if (this.repl.service) return new Disposable(() => {});
    return this.repl.setService(service);
  }

  // --- small UX helpers -------------------------------------------------
  warnOnce(message) {
    this.warned = this.warned || new Set();
    if (this.warned.has(message)) return;
    this.warned.add(message);
    atom.notifications.addWarning(`Julia (JETLS): ${message}`);
  }

  offerRestart() {
    if (this.restartNotice && !this.restartNotice.isDismissed()) return;
    this.restartNotice = atom.notifications.addInfo("Julia language server settings changed", {
      description: "These settings only take effect when the server restarts.",
      dismissable: true,
      buttons: [{
        text: "Restart server",
        onDidClick: () => { this.restartNotice.dismiss(); this.restartAllServers(); },
      }],
    });
  }
}

module.exports = new JuliaLanguageClient();
