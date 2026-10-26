const { AutoLanguageClient } = require("@savetheclocktower/atom-languageclient");
const { CompositeDisposable } = require("atom");
const { resolveJetls, buildArgs, buildEnv } = require("./launch");
const { buildJetlsSettings, parseJsonObject } = require("./settings");

const PKG = "pulsar-ide-julia";
const setting = (key) => atom.config.get(`${PKG}.${key}`);

// Changing these needs a new server process; the rest is sent live.
const RESTART_KEYS = ["jetlsPath", "juliaPath", "threads", "defaultEnvironment", "juliaFlags", "initializationOptionsJson"];

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
  startServerProcess(projectPath) {
    const exe = resolveJetls({ configured: setting("jetlsPath") });
    const args = buildArgs({
      threads: setting("threads"),
      defaultEnvironment: setting("defaultEnvironment"),
      juliaFlags: setting("juliaFlags"),
    });
    const env = buildEnv({ juliaPath: setting("juliaPath") });
    return super.spawn(exe, args, { cwd: projectPath, env });
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
