// Runs a short Julia command in the background (Pkg operations), keeping the end of what it printed.
const childProcess = require("child_process");
const os = require("os");
const { expandHome } = require("./paths");

const TAIL_CHARS = 4000;

// Resolves with { ok, output }: whether Julia exited with 0, and the end of what it printed.
// It never rejects: a julia that cannot be started is reported in `output`.
function runJulia({ juliaPath = "", args = [], env = process.env, spawn = childProcess.spawn, homedir = os.homedir() } = {}) {
  const command = juliaPath ? expandHome(juliaPath, homedir) : "julia";
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

// The last `lines` non-empty lines of `output`, for a notification.
function tailLines(output, lines = 15) {
  return String(output || "").split(/\r?\n/).filter((l) => l.trim() !== "").slice(-lines).join("\n");
}

module.exports = { runJulia, tailLines };
