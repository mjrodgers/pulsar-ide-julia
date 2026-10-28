// Pure helpers for building the JETLS launch command. No Pulsar APIs in here,
// so they are trivial to unit-test.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expandHome } = require("./julia/paths");

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

// First depot's bin directory: where `Pkg.Apps` puts executables (jetls, runic, jlfmt).
function depotBin({ env = process.env, homedir = os.homedir() } = {}) {
  const depot = (env.JULIA_DEPOT_PATH || "").split(path.delimiter).filter(Boolean)[0] || path.join(homedir, ".julia");
  return path.join(depot, "bin");
}

// Environment for the server process.
//  * Pkg apps run with the Julia that installed them. JULIA_APPS_JULIA_CMD overrides that
//    (https://pkgdocs.julialang.org/v1/apps/), which gives us Juno's "Julia path".
//  * JETLS looks up its formatter (`runic`, `jlfmt`) on the PATH it is given. A Pulsar
//    started from the Dock/Spotlight often has no shell PATH, so make sure the depot's bin
//    directory is on it (appended, so it never shadows anything).
function buildEnv({ juliaPath = "", env = process.env, homedir = os.homedir() } = {}) {
  const out = { ...env };
  if (juliaPath) out.JULIA_APPS_JULIA_CMD = expandHome(juliaPath, homedir);

  const key = Object.keys(out).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const dirs = (out[key] || "").split(path.delimiter).filter(Boolean);
  const bin = depotBin({ env, homedir });
  if (!dirs.includes(bin)) dirs.push(bin);
  out[key] = dirs.join(path.delimiter);
  return out;
}

module.exports = { expandHome, resolveJetls, buildArgs, buildEnv, depotBin };
