// Installs (or updates) DebugAdapter.jl in an environment of its own, `@pulsar-debugadapter` by default (setting
// **Debugger → DebugAdapter environment**), so it does not hold back the packages of the global environment
// (`@v1.12`): DebugAdapter needs particular versions of JuliaInterpreter and JSON, and an environment's packages
// must agree on the versions they share. The bootstrap (lib/debug/launch.js) adds that environment to LOAD_PATH
// only for the debugger.
const childProcess = require("child_process");
const os = require("os");
const { expandHome } = require("../julia/paths");

const DEFAULT_ENVIRONMENT = "@pulsar-debugadapter";
const TAIL_CHARS = 4000;

// Pkg.add installs it the first time; Pkg.update brings it (and only its dependencies, the environment holds nothing
// else) up to date; precompiling now saves the first debug session the wait.
const INSTALL_CODE = 'using Pkg; Pkg.add("DebugAdapter"); Pkg.update(); Pkg.precompile()';

// The environment for `--project=`: a shared one (`@name`) as is, otherwise a folder.
function projectArgument(environment, homedir = os.homedir()) {
  const env = String(environment || DEFAULT_ENVIRONMENT).trim() || DEFAULT_ENVIRONMENT;
  return env.startsWith("@") ? env : expandHome(env, homedir);
}

// The command a user can run instead, shown in messages.
function installCommand(environment) {
  return `julia --project=${projectArgument(environment)} -e '${INSTALL_CODE}'`;
}

// Runs the install. Resolves with { ok, output } (output: the end of what Julia printed).
function runInstall({ juliaPath = "", environment = "", env = process.env, spawn = childProcess.spawn, homedir = os.homedir() } = {}) {
  const command = juliaPath ? expandHome(juliaPath, homedir) : "julia";
  const args = [`--project=${projectArgument(environment, homedir)}`, "-e", INSTALL_CODE];
  return new Promise((resolve) => {
    let output = "";
    const keep = (d) => { output = (output + String(d)).slice(-TAIL_CHARS); };
    let child;
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, output: e.message });
      return;
    }
    if (child.stdout) child.stdout.on("data", keep);
    if (child.stderr) child.stderr.on("data", keep);
    child.once("error", (e) => resolve({ ok: false, output: e.code === "ENOENT" ? `Could not run \`${command}\`.` : e.message }));
    child.once("close", (code) => resolve({ ok: code === 0, output }));
  });
}

module.exports = { DEFAULT_ENVIRONMENT, INSTALL_CODE, projectArgument, installCommand, runInstall };
