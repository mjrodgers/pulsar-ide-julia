// Pure helpers for starting the debug adapter (DebugAdapter.jl) and building its launch request.
const os = require("os");
const path = require("path");
const { expandHome, findProjectDir } = require("../julia/paths");
const { parseJsonObject } = require("../settings");
const { DEFAULT_ENVIRONMENT, projectArgument } = require("./install");

// The adapter talks DAP over a socket we listen on: `julia ... -e BOOTSTRAP <pipe> <adapter environment>`. The
// bootstrap runs in the debuggee's project (so the program sees its own packages). DebugAdapter is installed in an
// environment of its own (lib/debug/install.js), which the bootstrap adds at the *end* of LOAD_PATH, for this
// process only.
//
// The end, because Julia loads a package from the first environment on LOAD_PATH that has it, including the
// packages DebugAdapter itself uses (JSON, Parsers, JuliaInterpreter, …). Placed earlier, the adapter's environment
// supplied its versions of those to everything after it: a program loading JSON from the global environment
// (`@v#.#`), such as a script outside any project, got the adapter's JSON 0.21 instead of the global JSON 1.x, and
// mismatched versions can fail to load or precompile. At the end, the program's
// project and the global environment decide every version they have; the adapter's environment only supplies what
// they lack (DebugAdapter itself). A DebugAdapter still installed in the global environment is found there first.
const BOOTSTRAP = [
  "using Sockets",
  "length(ARGS) >= 2 && !isempty(ARGS[2]) && !(ARGS[2] in LOAD_PATH) && push!(LOAD_PATH, ARGS[2])",
  "import DebugAdapter",
  "conn = Sockets.connect(ARGS[1])",
  "run(DebugAdapter.DebugSession(conn))",
].join("; ");

// Splits `--color=yes -e "using Revise"` into arguments. Understands single and double quotes and backslash
// escapes outside single quotes; this is for a settings field, not a full shell.
function splitArgs(text) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < src.length) cur += src[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < src.length) {
      cur += src[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) { out.push(cur); cur = ""; started = false; }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

// environment: "" -> the project of the file being debugged (if it has one); "@." / "@v1.12" / "@name" as is;
//              anything else is a directory.
// adapterEnvironment: where DebugAdapter is installed ("@pulsar-debugadapter" by default; a folder is expanded).
function buildAdapterCommand({
  juliaPath = "",
  threads = "",
  environment = "",
  adapterEnvironment = DEFAULT_ENVIRONMENT,
  projectDir = null,
  flags = "",
  pipe,
  homedir = os.homedir(),
} = {}) {
  const args = [];
  if (threads) args.push(`--threads=${threads}`);
  const project = environment ? (environment.startsWith("@") ? environment : expandHome(environment, homedir)) : projectDir;
  if (project) args.push(`--project=${project}`);
  args.push(...splitArgs(flags));
  args.push("-e", BOOTSTRAP, pipe, projectArgument(adapterEnvironment, homedir));
  return { command: juliaPath ? expandHome(juliaPath, homedir) : "julia", args };
}

// The `launch` request's arguments, as DebugAdapter.jl's JuliaLaunchArguments defines them: program (required),
// stopOnEntry, cwd, env, project, args, code, compiledModulesOrFunctions, compiledMode, noDebug. We send
// `program` and `stopOnEntry` always, the rest only when set. Extra JSON from the settings is merged on top
// (so it can override anything), and a `null` value removes a field.
function buildLaunchArguments({ file, stopOnEntry = false, programArgs = "", compiledMode = false, compiledModules = [], extraJson = "" } = {}) {
  const parsed = parseJsonObject(extraJson, "Debugger launch arguments");
  const args = { program: file, stopOnEntry: !!stopOnEntry };
  const argv = splitArgs(programArgs);
  if (argv.length) args.args = argv;
  if (compiledMode) args.compiledMode = true;
  const modules = (compiledModules || []).map((m) => String(m).trim()).filter(Boolean);
  if (modules.length) args.compiledModulesOrFunctions = modules;
  Object.assign(args, parsed.value);
  for (const key of Object.keys(args)) if (args[key] === null) delete args[key];
  return { args, error: parsed.error };
}

// Where to run the adapter and which project it should use, for the file being debugged.
function adapterContext(file, { exists } = {}) {
  const dir = path.dirname(file);
  return { cwd: dir, projectDir: findProjectDir(dir, exists) };
}

module.exports = { BOOTSTRAP, splitArgs, buildAdapterCommand, buildLaunchArguments, adapterContext };
