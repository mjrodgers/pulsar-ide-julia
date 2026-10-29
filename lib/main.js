const { AutoLanguageClient, Convert } = require("@savetheclocktower/atom-languageclient");
const { CompositeDisposable, Disposable } = require("atom");
const { resolveJetls, buildArgs, buildEnv } = require("./launch");
const { shellEnvironment } = require("./shell-env");
const { connectViaPipe, withSocketStdio, drainStdout } = require("./channel");
const { createStderrClassifier } = require("./stderr");
const { decorateOutline, describeSymbols, symbolsToOutline, symbolsToEntries, isDocumentSymbolReply } = require("./outline");
const path = require("path");
const { buildJetlsSettings, parseJsonObject } = require("./settings");
const { ReplController } = require("./repl");
const { InlineResults } = require("./results");
const { CellSeparators } = require("./cells");
const { ReplStatus } = require("./status");
const { TestController } = require("./tests");
const { createDebugAdapterProvider } = require("./debug/provider");
const { ModuleChooser } = require("./workspace/module-chooser");
const { ReplBridge } = require("./workspace/repl-bridge");
const { Picker } = require("./picker");
const { ModuleFollower } = require("./workspace/module-follow");
const { packageOf } = require("./julia/paths");
const { ServerRegistry, displayName } = require("./server/registry");
const { isWatchedByJetls } = require("./server/watched-files");
const { ServersPane, URI: SERVERS_URI } = require("./server/servers-pane");

const PKG = "pulsar-ide-julia";
const setting = (key) => atom.config.get(`${PKG}.${key}`);

// Settings are grouped (server, outline, repl, debugger); see lib/config-keys.js. RESTART_KEYS need a new server
// process, the rest of the server group is sent live.
const { RESTART_KEYS, migrateSettings } = require("./config-keys");

class JuliaLanguageClient extends AutoLanguageClient {
  getGrammarScopes() { return ["source.julia"]; }
  getLanguageName() { return "Julia"; }
  getServerName() { return "JETLS"; }
  getPackageName() { return PKG; }

  activate() {
    // Settings saved under the old, ungrouped names move to their groups (once; afterwards there is nothing to move).
    migrateSettings(atom.config, PKG);
    super.activate();
    this.servers = new ServerRegistry({
      client: this,
      workspace: atom.workspace,
      isJulia: (editor) => !!editor.getGrammar && this.getGrammarScopes().includes(editor.getGrammar().scopeName),
    });
    this.replBridge = new ReplBridge({ startupDir: path.join(atom.getConfigDirPath(), PKG) });
    this.picker = new Picker({ workspace: atom.workspace });
    // Results of sent code, shown under it (opt-in: REPL → Inline results).
    this.results = new InlineResults({ openFile: (file) => atom.workspace.open(file) });
    this.replBridge.onDidReportResult((message) => this.results.report(message));
    // A line above each cell marker (REPL → Cell separators).
    this.cells = new CellSeparators({
      workspace: atom.workspace,
      isJulia: (editor) => !!editor.getGrammar && this.getGrammarScopes().includes(editor.getGrammar().scopeName),
      enabled: () => setting("repl.cellSeparators") !== false,
    });
    this.cells.start();
    this.repl = new ReplController({
      bridge: this.replBridge,
      results: this.results,
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
    this.tests = new TestController({
      setting,
      workspace: atom.workspace,
      notifications: atom.notifications,
      repl,
      connectionFor: (editor) => this.getConnectionForEditor(editor),
      uriFor: (file) => Convert.pathToUri(file),
    });
    const testCommands = Object.fromEntries(
      Object.entries(this.tests.commandTable()).map(([name, fn]) => [`${PKG}:${name}`, fn])
    );
    // The debugger and the Workspace pane are drawn by pulsar-ide-debugger, which gets Julia's debug adapter and the
    // REPL's variables from provideDebugAdapter(). Which module of the REPL the pane shows is decided here: a
    // setting, or "Follow editor".
    const chooser = new ModuleChooser({ choice: setting("repl.workspaceModule") });
    this.moduleChooser = chooser;
    // The REPL's module, busy state and last timing in the status bar (consumeStatusBar). A click opens
    // pulsar-ide-debugger's Workspace pane, which shows the REPL's variables.
    this.replStatus = new ReplStatus({ bridge: this.replBridge, onClick: () => this.openWorkspacePane() });
    this.follower = new ModuleFollower({
      workspace: atom.workspace,
      fetchSymbols: (editor) => this.fetchDocumentSymbols(editor),
      onPath: (parts) => chooser.followTo(parts),
      isActive: () => chooser.following,
      packageOf: (file) => packageOf(file),
    });
    this.follower.watchModel(chooser);
    this.follower.start();
    const stopChoosing = chooser.onDidChooseModule((choice) => {
      if (setting("repl.workspaceModule") !== choice) atom.config.set(`${PKG}.repl.workspaceModule`, choice);
    });
    this.subscriptions = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        [`${PKG}:restart-language-server`]: () => this.restartAllServers(),
        [`${PKG}:restart-language-server-for-project-folder`]: () => this.restartServerForActiveEditor(),
        [`${PKG}:show-language-servers`]: () => atom.workspace.open(SERVERS_URI, { searchAllPanes: true }),
        [`${PKG}:dump-document-symbols`]: () => this.dumpDocumentSymbols(),
        [`${PKG}:open-repl`]: () => repl.openRepl(),
        [`${PKG}:send-selection-or-definition`]: () => repl.sendSelectionOrDefinition(),
        [`${PKG}:send-selection-or-definition-and-advance`]: () => repl.sendSelectionOrDefinition({ advance: true }),
        [`${PKG}:send-cell`]: () => repl.sendCell(),
        [`${PKG}:send-cell-and-advance`]: () => repl.sendCell({ advance: true }),
        [`${PKG}:send-file`]: () => repl.sendFile(),
        [`${PKG}:send-all-above`]: () => repl.sendAllAbove(),
        [`${PKG}:send-all-below`]: () => repl.sendAllBelow(),
        [`${PKG}:restart-repl`]: () => repl.restartRepl(),
        [`${PKG}:interrupt-repl`]: () => repl.interruptRepl(),
        [`${PKG}:clear-results`]: () => this.results.clear(atom.workspace.getActiveTextEditor() || null),
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
        ...testCommands,
      }),
      new Disposable(stopChoosing),
      atom.workspace.addOpener((uri) => (uri === SERVERS_URI
        ? new ServersPane(this.servers, {
          notify: (kind, message) => atom.notifications[kind](`Julia (JETLS): ${message}`),
          restartAll: () => this.restartAllServers(),
        })
        : undefined)),
      atom.config.onDidChange(`${PKG}.repl.workspaceModule`, ({ newValue }) => chooser.setChoice(newValue)),
      atom.config.onDidChange(`${PKG}.repl.cellSeparators`, () => this.cells.refreshAll()),
      ...RESTART_KEYS.map((key) => atom.config.onDidChange(`${PKG}.${key}`, () => this.offerRestart()))
    );
  }

  deactivate() {
    if (this.subscriptions) this.subscriptions.dispose();
    if (this.follower) this.follower.dispose();
    if (this.picker) this.picker.destroy();
    if (this.repl) this.repl.dispose();
    if (this.results) this.results.dispose();
    if (this.cells) this.cells.dispose();
    if (this.replStatus) this.replStatus.dispose();
    if (this.replBridge) this.replBridge.dispose();
    return super.deactivate();
  }

  openWorkspacePane() {
    if (atom.packages.isPackageActive("pulsar-ide-debugger")) {
      atom.commands.dispatch(atom.views.getView(atom.workspace), "pulsar-ide-debugger:open-workspace");
    } else {
      atom.notifications.addInfo("Julia REPL: the REPL's variables are shown in the Workspace pane of the pulsar-ide-debugger package.", {
        description: "Install `pulsar-ide-debugger` to see them.",
      });
    }
  }

  // The `debug-adapter` service, for pulsar-ide-debugger (see lib/debug/provider.js).
  provideDebugAdapter() {
    return createDebugAdapterProvider({
      setting,
      // julia is looked up on the login shell's PATH, as for the language server (see startServerProcess).
      shellEnvironment,
      replBridge: this.replBridge,
      chooser: this.moduleChooser,
    });
  }

  // --- launching --------------------------------------------------------
  // Called once per project root (the fork starts one server per Pulsar root).
  // JETLS picks the environment per file (nearest Project.toml), so cwd = root
  // is all it needs.
  async startServerProcess(projectPath) {
    // Opening a Julia file can start the server before Pulsar has read the shell's PATH (a Pulsar started from the
    // Dock or a desktop launcher): wait for it, so `jetls` and the Julia it runs are found as in a terminal.
    if (!(await shellEnvironment())) {
      this.logger.warn("pulsar-ide-julia: the shell environment was not loaded in time; starting JETLS with Pulsar's own PATH");
    }
    const exe = resolveJetls({ configured: setting("server.jetlsPath") });
    const args = buildArgs({
      threads: setting("server.threads"),
      defaultEnvironment: setting("server.defaultEnvironment"),
      juliaFlags: setting("server.juliaFlags"),
    });
    const options = { cwd: projectPath, env: buildEnv({ juliaPath: setting("server.juliaPath") }) };

    if (setting("server.channel") === "stdio") return this.spawn(exe, args, options);

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
  // anything under that key changes, so the key is the `server` group alone: REPL, debugger or pane settings
  // changing must not make every JETLS process reload its configuration.
  supportsWorkspaceConfiguration() { return true; }
  getRootConfigurationKey() { return `${PKG}.server`; }
  // `config` is the server group: {autoInstantiate, debounce, formatter, settingsJson, ...}.
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
    // JETLS adjusts a few behaviours per client by name (completion details, LaTeX/emoji labels, rename); without
    // this it cannot tell Pulsar from an unknown client.
    params.clientInfo = { name: "Pulsar", version: typeof atom !== "undefined" && atom.getVersion ? atom.getVersion() : undefined };
    const { value, error } = parseJsonObject(setting("server.initializationOptionsJson"), "Initialization options");
    if (error) this.warnOnce(error);
    if (Object.keys(value).length) params.initializationOptions = value;
    return params;
  }

  // Only the file changes JETLS watches are forwarded (see lib/server/watched-files.js).
  filterChangeWatchedFiles(filePath) {
    return isWatchedByJetls(filePath);
  }

  // --- one server at a time -----------------------------------------------
  // Restarts only the server of the active editor's project folder, e.g. to reload a dependency checkout that changed
  // (a server loads dependencies once and does not see later edits to them).
  async restartServerForActiveEditor() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!this.servers.available) {
      atom.notifications.addInfo("Julia (JETLS): restarting all servers (this language client version cannot restart just one).");
      return this.restartAllServers();
    }
    const root = this.servers.rootOf(editor);
    if (!root) {
      return atom.notifications.addWarning("Julia (JETLS): open a saved file inside one of the project folders first.");
    }
    try {
      const started = await this.servers.restart(root);
      if (!started) atom.notifications.addInfo(`Julia (JETLS): stopped the server for ${displayName(root)}; it starts again when you open a Julia file there.`);
    } catch (e) {
      atom.notifications.addError(`Julia (JETLS): could not restart the server for ${displayName(root)}`, { detail: String((e && e.message) || e), dismissable: true });
    }
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
    // The same URI the fork's document sync used for didOpen, so JETLS finds the document it already has.
    return connection.documentSymbol({ textDocument: { uri: Convert.pathToUri(editor.getPath()) } });
  }

  async getOutline(editor) {
    try {
      const symbols = await this.fetchDocumentSymbols(editor);
      if (isDocumentSymbolReply(symbols)) {
        return symbolsToOutline(symbols, {
          Point: require("atom").Point,
          showLocals: setting("outline.locals") === true,
          signatures: setting("outline.signatures") !== false,
        });
      }
      if (Array.isArray(symbols) && symbols.length === 0) return { outlineTrees: [] };
    } catch (e) {
      this.logger.warn("Could not build the outline from the raw symbols; using the default", e);
    }

    const outline = await super.getOutline(editor);
    if (!outline || setting("outline.signatures") === false) return outline;
    try {
      return decorateOutline(outline, (row) => editor.lineTextForBufferRow(row));
    } catch (e) {
      this.logger.warn("Could not add signatures to the outline", e);
      return outline;
    }
  }

  // --- Go to Symbol (symbols-view) -----------------------------------------
  // The fork's symbol adapter also drops `detail`, so every method of a function shows up as
  // the same bare name. For the file's symbols, build the list from the raw reply instead,
  // with each argument list as the entry's context (lib/outline.js). Project-wide search
  // and go-to-declaration stay with the adapter.
  provideSymbols() {
    const provider = super.provideSymbols();
    const adapterGetSymbols = provider.getSymbols;
    provider.getSymbols = async (meta, listController) => {
      if (meta && meta.type === "file" && meta.editor) {
        try {
          const symbols = await this.fetchDocumentSymbols(meta.editor);
          if (isDocumentSymbolReply(symbols)) {
            const { Point, Range } = require("atom");
            return symbolsToEntries(symbols, {
              Point,
              Range,
              showLocals: setting("outline.locals") === true,
              signatures: setting("outline.signatures") !== false,
            });
          }
          if (Array.isArray(symbols) && symbols.length === 0) return [];
        } catch (e) {
          this.logger.warn("Could not build the symbol list from the raw symbols; using the default", e);
        }
      }
      return adapterGetSymbols(meta, listController);
    };
    return provider;
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
  consumeStatusBar(statusBar) {
    if (!this.replStatus) return new Disposable(() => {});
    const attached = this.replStatus.attach(statusBar);
    return new Disposable(() => attached.dispose());
  }

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
