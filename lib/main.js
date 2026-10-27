const { AutoLanguageClient } = require("@savetheclocktower/atom-languageclient");
const { CompositeDisposable } = require("atom");
const { resolveJetls, buildArgs, buildEnv } = require("./launch");
const { connectViaPipe, withSocketStdio, drainStdout } = require("./channel");
const { buildJetlsSettings, parseJsonObject } = require("./settings");

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
    this.subscriptions = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        [`${PKG}:restart-language-server`]: () => this.restartAllServers(),
      }),
      ...RESTART_KEYS.map((key) => atom.config.onDidChange(`${PKG}.${key}`, () => this.offerRestart()))
    );
  }

  deactivate() {
    if (this.subscriptions) this.subscriptions.dispose();
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
