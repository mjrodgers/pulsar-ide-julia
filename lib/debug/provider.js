// What pulsar-ide-julia gives pulsar-ide-debugger through the `debug-adapter` service: how to start Julia with
// DebugAdapter.jl, the `launch` request for a file, and the REPL as a live source for the Workspace pane.
//
// The debugger package draws everything and keeps the breakpoints; all Julia-specific settings are read here.
const { buildLaunchArguments } = require("./launch");
const { launchAdapter, explainLaunchFailure } = require("./adapter-process");

// deps:
//   setting(key)            this package's settings ("debugger.juliaPath", ...)
//   shellEnvironment()      resolves once Pulsar has the login shell's PATH (julia is looked up on it)
//   replBridge              optional: onDidConnect(source) / onDidDisconnect() of the REPL helper
//   chooser                 optional: a ModuleChooser that gives the REPL source its module menu
//   launch                  for specs: replaces launchAdapter
//   env                     for specs: the environment Julia starts with (default: process.env, read at launch)
function createDebugAdapterProvider({ setting, shellEnvironment = async () => true, replBridge = null, chooser = null, launch = launchAdapter, env = null }) {
  const settings = () => ({
    juliaPath: setting("debugger.juliaPath"),
    threads: setting("debugger.threads"),
    environment: setting("debugger.environment"),
    flags: setting("debugger.flags"),
  });

  return {
    name: "Julia",
    grammarScopes: ["source.julia"],
    adapterID: "julia",

    async launch({ file, log }) {
      // Wait for the shell's PATH, so `julia` is found the same way a terminal would find it.
      await shellEnvironment();
      const { socket, child } = await launch({ file, settings: settings(), log, env: env || process.env });
      return { stream: socket, child };
    },

    launchRequest({ file }) {
      const { args, error } = buildLaunchArguments({
        file,
        stopOnEntry: setting("debugger.stopOnEntry"),
        programArgs: setting("debugger.programArguments"),
        compiledMode: setting("debugger.compiledMode"),
        compiledModules: setting("debugger.compiledModules"),
        extraJson: setting("debugger.launchArgumentsJson"),
      });
      return { request: "launch", args, warning: error || undefined };
    },

    exceptionFilters() {
      return setting("debugger.exceptionFilters") || [];
    },

    explainFailure(error) {
      return explainLaunchFailure(error, settings());
    },

    // The REPL's variables, while nothing is being debugged.
    observeWorkspaceSource(callback) {
      if (!replBridge) return { dispose() {} };
      let current = null;
      const offer = (source) => {
        if (current && chooser) chooser.detach(current);
        current = source || null;
        if (current && chooser) chooser.attach(current);
        callback(current);
      };
      const offConnect = replBridge.onDidConnect((source) => offer(source));
      const offDisconnect = replBridge.onDidDisconnect(() => offer(null));
      if (replBridge.source) offer(replBridge.source);
      return {
        dispose() {
          for (const off of [offConnect, offDisconnect]) {
            if (typeof off === "function") off();
            else if (off && typeof off.dispose === "function") off.dispose();
          }
          if (current && chooser) chooser.detach(current);
          current = null;
        },
      };
    },
  };
}

module.exports = { createDebugAdapterProvider };
