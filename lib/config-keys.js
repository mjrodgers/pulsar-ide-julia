// The package's settings are grouped (server, outline, repl, tests, debugger). Earlier versions kept them all at the top
// level; MOVED maps each old name to its place now, and migrateSettings() carries over what a user had set, once.
const MOVED = {
  // the JETLS server (only this group is sent to JETLS; see getRootConfigurationKey in main.js)
  jetlsPath: "server.jetlsPath",
  juliaPath: "server.juliaPath",
  channel: "server.channel",
  threads: "server.threads",
  defaultEnvironment: "server.defaultEnvironment",
  juliaFlags: "server.juliaFlags",
  autoInstantiate: "server.autoInstantiate",
  debounce: "server.debounce",
  formatter: "server.formatter",
  settingsJson: "server.settingsJson",
  initializationOptionsJson: "server.initializationOptionsJson",
  // outline
  outlineSignatures: "outline.signatures",
  outlineLocals: "outline.locals",
  // REPL and the workspace pane
  replJuliaPath: "repl.juliaPath",
  replThreads: "repl.threads",
  replEnvironment: "repl.environment",
  replFlags: "repl.flags",
  replSendVia: "repl.sendVia",
  replBracketedPaste: "repl.bracketedPaste",
  replWorkspace: "repl.workspace",
  replModuleAware: "repl.moduleAware",
  workspaceModule: "repl.workspaceModule",
  // debugger
  debugJuliaPath: "debugger.juliaPath",
  debugEnvironment: "debugger.environment",
  debugThreads: "debugger.threads",
  debugFlags: "debugger.flags",
  debugStopOnEntry: "debugger.stopOnEntry",
  debugLaunchArgumentsJson: "debugger.launchArgumentsJson",
  debugExceptionFilters: "debugger.exceptionFilters",
  debugProgramArguments: "debugger.programArguments",
  debugCompiledMode: "debugger.compiledMode",
  debugCompiledModules: "debugger.compiledModules",
};

// Settings that moved to another package (full key paths). The pane settings belong to pulsar-ide-debugger now.
const MOVED_OUT = {
  debugOpenWorkspace: "pulsar-ide-debugger.openWorkspace",
  debugOpenOutput: "pulsar-ide-debugger.openOutput",
  "debugger.openWorkspace": "pulsar-ide-debugger.openWorkspace",
  "debugger.openOutput": "pulsar-ide-debugger.openOutput",
};

// Settings added after the regrouping (no old name to move from).
const ADDED = ["tests.environment", "tests.loadPackage", "tests.setup"];

// Settings that need a new JETLS process; changing one offers a restart.
const RESTART_KEYS = ["server.jetlsPath", "server.juliaPath", "server.channel", "server.threads", "server.defaultEnvironment", "server.juliaFlags", "server.initializationOptionsJson"];

// Moves values set under old names to the new ones and removes the old names. `config` is atom.config (get, set,
// unset); an old name has a value only if the user set it, since it is no longer in the schema. Returns the old names
// that were moved.
function migrateSettings(config, pkg) {
  const moved = [];
  const move = (from, toPath) => {
    const oldPath = `${pkg}.${from}`;
    const value = config.get(oldPath);
    if (value === undefined) return;
    config.set(toPath, value);
    config.unset(oldPath);
    moved.push(from);
  };
  for (const [from, to] of Object.entries(MOVED)) move(from, `${pkg}.${to}`);
  for (const [from, to] of Object.entries(MOVED_OUT)) move(from, to);
  return moved;
}

module.exports = { MOVED, MOVED_OUT, ADDED, RESTART_KEYS, migrateSettings };
