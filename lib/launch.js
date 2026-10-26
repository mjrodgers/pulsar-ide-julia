// Pure helpers for building the JETLS launch command. No Pulsar APIs in here,
// so they are trivial to unit-test.
const fs = require("fs");
const os = require("os");
const path = require("path");

function expandHome(p, homedir = os.homedir()) {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

// Pulsar launched from a desktop launcher often lacks ~/.julia/bin on PATH
// (same problem Juno users hit with `julia`). An explicit setting always wins;
// otherwise prefer <depot>/bin/jetls when it exists, then fall back to PATH.
function resolveJetls({
  configured = "jetls",
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (configured && configured !== "jetls") return expandHome(configured, homedir);
  const exe = platform === "win32" ? "jetls.exe" : "jetls";
  const depot =
    (env.JULIA_DEPOT_PATH || "").split(path.delimiter).filter(Boolean)[0] ||
    path.join(homedir, ".julia");
  const candidate = path.join(depot, "bin", exe);
  return exists(candidate) ? candidate : "jetls";
}

// Flags before `--` go to the Julia runtime; everything after goes to JETLS.
function buildArgs({ threads = "", defaultEnvironment = "", juliaFlags = [], homedir = os.homedir() } = {}) {
  const flags = [];
  if (threads) flags.push(`--threads=${threads}`);
  if (defaultEnvironment) {
    const env = defaultEnvironment.startsWith("@") ? defaultEnvironment : expandHome(defaultEnvironment, homedir);
    flags.push(`--project=${env}`);
  }
  flags.push(...juliaFlags.map((f) => f.trim()).filter(Boolean));
  return [...flags, "--", "serve"];
}

// Pkg apps run with the Julia that installed them. JULIA_APPS_JULIA_CMD overrides
// that (https://pkgdocs.julialang.org/v1/apps/), which gives us Juno's "Julia path".
function buildEnv({ juliaPath = "", env = process.env, homedir = os.homedir() } = {}) {
  const out = { ...env };
  if (juliaPath) out.JULIA_APPS_JULIA_CMD = expandHome(juliaPath, homedir);
  return out;
}

module.exports = { expandHome, resolveJetls, buildArgs, buildEnv };
