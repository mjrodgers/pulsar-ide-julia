// Julia project lookups shared by the REPL, the debugger and the workspace pane (no Pulsar in here).
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_FILES = ["JuliaProject.toml", "Project.toml"]; // Julia prefers JuliaProject.toml

function expandHome(p, homedir = os.homedir()) {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return p;
}

// Nearest directory at or above `startDir` that has a Project.toml / JuliaProject.toml.
function findProjectDir(startDir, exists = fs.existsSync) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    if (PROJECT_FILES.some((f) => exists(path.join(dir, f)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The top-level `name` and `uuid` of a project file's text (keys before the first `[table]`).
// Only these two plain string keys are needed, so this is not a TOML parser.
function parseProjectHeader(text) {
  const out = { name: null, uuid: null };
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*(name|uuid)\s*=\s*"([^"]*)"\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// { name, uuid } of the project in `dir`, or null if it has no project file. Missing keys are null.
function readProject(dir, { read = (f) => fs.readFileSync(f, "utf8") } = {}) {
  if (!dir) return null;
  for (const file of PROJECT_FILES) {
    let text;
    try { text = read(path.join(dir, file)); } catch (e) { continue; }
    return parseProjectHeader(text);
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The package a source file belongs to: { name, uuid, dir } when the file is under `src/` of a project that has a
// name and a uuid (a package), else null. Files elsewhere in a package (test/, scripts) run in Main, as Julia
// runs them; ext/ files belong to extension modules, which are not handled here.
function packageOf(file, { exists = fs.existsSync, read } = {}) {
  if (!file) return null;
  const dir = findProjectDir(path.dirname(file), exists);
  if (!dir) return null;
  const rel = path.relative(path.join(dir, "src"), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const project = readProject(dir, read ? { read } : undefined);
  if (!project || !project.name || !project.uuid || !UUID.test(project.uuid)) return null;
  return { name: project.name, uuid: project.uuid.toLowerCase(), dir };
}

// The project to start a REPL in for files under `startDir`: the nearest project, except that a package's test
// environment (`<package>/test/Project.toml`, which has no name) gives way to the package itself. A REPL started
// from a test file then has the package's own environment, with this checkout of the package, as `Pkg.test` would;
// the test environment is added on top when tests are run (lib/tests.js).
function replProjectDir(startDir, { exists = fs.existsSync, read } = {}) {
  const dir = findProjectDir(startDir, exists);
  if (!dir || path.basename(dir) !== "test") return dir;
  const project = readProject(dir, read ? { read } : undefined);
  if (project && project.name) return dir;
  const parent = findProjectDir(path.dirname(dir), exists);
  const parentProject = parent ? readProject(parent, read ? { read } : undefined) : null;
  return parentProject && parentProject.name ? parent : dir;
}

module.exports = { expandHome, findProjectDir, replProjectDir, parseProjectHeader, readProject, packageOf, PROJECT_FILES };
