// What pulsar-ide-julia gives pulsar-ide-debugger:
// - through `debug-adapter` (0.2.0): how to start Julia with DebugAdapter.jl, and the configuration for Debug File;
// - through `live-variables` (0.1.0): the REPL's variables, for the Workspace pane while nothing is being debugged.
//
// The debugger package draws everything and keeps the breakpoints; all Julia-specific settings are read here.
// Configurations have the type "julia" and DebugAdapter.jl's launch arguments (program, stopOnEntry, args, cwd,
// project, compiledMode, compiledModulesOrFunctions, ...), as in VS Code's launch.json for Julia.
const path = require("path");
const { buildLaunchArguments } = require("./launch");
const { launchAdapter, explainLaunchFailure } = require("./adapter-process");

// deps:
//   setting(key)            this package's settings ("debugger.juliaPath", ...)
//   shellEnvironment()      resolves once Pulsar has the login shell's PATH (julia is looked up on it)
//   launch                  for specs: replaces launchAdapter
//   env                     for specs: the environment Julia starts with (default: process.env, read at launch)
function createDebugAdapterProvider({ setting, shellEnvironment = async () => true, launch = launchAdapter, env = null }) {
  const settings = () => ({
    juliaPath: setting("debugger.juliaPath"),
    threads: setting("debugger.threads"),
    environment: setting("debugger.environment"),
    adapterEnvironment: setting("debugger.adapterEnvironment"),
    flags: setting("debugger.flags"),
  });

  return {
    name: "Julia",
    types: ["julia"],
    grammarScopes: ["source.julia"],

    // Debug File: the file, with the launch settings (stop on entry, program arguments, compiled mode, extra JSON).
    // Configurations from launch.json are used as they are written.
    configurationForFile({ file }) {
      const { args, error } = buildLaunchArguments({
        file,
        stopOnEntry: setting("debugger.stopOnEntry"),
        programArgs: setting("debugger.programArguments"),
        compiledMode: setting("debugger.compiledMode"),
        compiledModules: setting("debugger.compiledModules"),
        extraJson: setting("debugger.launchArgumentsJson"),
      });
      return {
        configuration: { type: "julia", request: "launch", name: `Debug ${path.basename(file)}`, ...args },
        warning: error || undefined,
      };
    },

    // Julia itself (path, threads, environment, flags) comes from the settings for every configuration.
    async createAdapter(configuration, { log, projectPath }) {
      // Wait for the shell's PATH, so `julia` is found the same way a terminal would find it.
      await shellEnvironment();
      // The adapter runs next to the program, in its project; without a program, in the project folder.
      const file = configuration.program || path.join(projectPath || process.cwd(), "main.jl");
      const { socket, child } = await launch({ file, settings: settings(), log, env: env || process.env });
      return { stream: socket, process: child };
    },

    defaultExceptionFilters() {
      return setting("debugger.exceptionFilters") || [];
    },

    explainFailure(error) {
      return explainLaunchFailure(error, settings());
    },
  };
}

// The `live-variables` provider: one source while the REPL's helper is connected. `chooser` (a ModuleChooser)
// gives the source its module menu.
function createLiveVariablesProvider({ replBridge, chooser = null }) {
  return {
    name: "Julia",
    grammarScopes: ["source.julia"],
    observeSources(callback) {
      let current = null;
      const offer = (source) => {
        if (current && chooser) chooser.detach(current);
        current = source || null;
        if (current && chooser) chooser.attach(current);
        if (current) callback(current); // a source says itself when it goes (onDidDestroy)
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

module.exports = { createDebugAdapterProvider, createLiveVariablesProvider };
