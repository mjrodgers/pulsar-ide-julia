// Starts `julia` running DebugAdapter.jl and waits for it to connect to a local socket.
const childProcess = require("child_process");
const { connectViaPipe } = require("../channel");
const { buildAdapterCommand, adapterContext } = require("./launch");

const TAIL_CHARS = 4000;

// Resolves with {socket, child}. On failure the error carries `stderrTail`, the end of what Julia printed.
async function launchAdapter({ file, settings, log, spawn = childProcess.spawn, connect = connectViaPipe, env = process.env, exists }) {
  const { cwd, projectDir } = adapterContext(file, { exists });
  let tail = "";
  try {
    return await connect((pipe) => {
      const { command, args } = buildAdapterCommand({
        juliaPath: settings.juliaPath,
        threads: settings.threads,
        environment: settings.environment,
        flags: settings.flags,
        projectDir,
        pipe,
      });
      if (log) log.note(`Starting ${command}${projectDir ? ` (project ${projectDir})` : ""}`);
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => log && log.append(String(d), "stdout"));
      child.stderr.on("data", (d) => {
        tail = (tail + String(d)).slice(-TAIL_CHARS);
        if (log) log.append(String(d), "stderr");
      });
      return child;
    });
  } catch (e) {
    e.stderrTail = tail;
    throw e;
  }
}

// A readable explanation for the failures people will actually hit.
function explainLaunchFailure(error, settings = {}) {
  const tail = error.stderrTail || "";
  if (error.code === "ENOENT") {
    return `Could not run \`${settings.juliaPath || "julia"}\`. Set "Debugger: Julia path" in the package settings, or put julia on the PATH Pulsar starts with.`;
  }
  if (/DebugAdapter/.test(tail) && /(not found|Package .* is required|ArgumentError|Unsatisfiable)/i.test(tail)) {
    return "DebugAdapter.jl is not installed in the default Julia environment. Install it with: julia -e 'using Pkg; Pkg.add(\"DebugAdapter\")'";
  }
  return error.message || String(error);
}

module.exports = { launchAdapter, explainLaunchFailure };
