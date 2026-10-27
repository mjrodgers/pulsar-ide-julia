// Julia commands and lookups for working folders and environments (no Pulsar in here).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { rawString } = require("./julia-string");

const cdCommand = (dir) => `cd(${rawString(dir)})`;
const cdHomeCommand = () => "cd()";
const activateCommand = (dir) => `import Pkg; Pkg.activate(${rawString(dir)})`;
const activateSharedCommand = (name) => `import Pkg; Pkg.activate(${rawString(name)}; shared=true)`;
const activateDefaultCommand = () => "import Pkg; Pkg.activate()";

// Where Julia keeps shared environments: the first entry of JULIA_DEPOT_PATH, else ~/.julia.
function depotDir({ env = process.env, home = os.homedir() } = {}) {
  const first = String(env.JULIA_DEPOT_PATH || "").split(path.delimiter).find((d) => d.trim() !== "");
  if (!first) return path.join(home, ".julia");
  return first.startsWith("~") ? path.join(home, first.slice(1)) : first;
}

// The names of the shared environments (`<depot>/environments/<name>` holding a project file), sorted.
function listSharedEnvironments(depot, fsModule = fs) {
  const root = path.join(depot, "environments");
  let entries;
  try {
    entries = fsModule.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() || (d.isSymbolicLink && d.isSymbolicLink()))
    .map((d) => d.name)
    .filter((name) => ["Project.toml", "JuliaProject.toml"].some((f) => fsModule.existsSync(path.join(root, name, f))))
    .sort((a, b) => a.localeCompare(b));
}

module.exports = {
  cdCommand, cdHomeCommand, activateCommand, activateSharedCommand, activateDefaultCommand, depotDir, listSharedEnvironments,
};
