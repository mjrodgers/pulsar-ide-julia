// JETLS checks a folder's environment once, when its server starts, and keeps what it loaded until it restarts.
// After a branch switch that changes `Project.toml`, its diagnostics and hovers can be wrong (or it analyzes the
// package as a script) with no message at all. This watches the environment files of each folder with a server and
// reports, per folder, the ones whose content changed since the server started. No Pulsar APIs in here: main.js
// feeds it Pulsar's file events (atom.project.onDidChangeFiles).
//
// Only project files are watched, not manifests: JETLS writes `Manifest.toml` itself when it instantiates, which
// needs no restart, and a branch switch changes `Project.toml` (manifests are usually not in git).

const fs = require("fs");
const path = require("path");

const ENV_FILES = ["Project.toml", "JuliaProject.toml"];

const isEnvironmentFile = (file) => ENV_FILES.includes(path.basename(String(file)));

// Whether `file` is inside `root` (or is `root`).
function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// The deepest of `roots` that contains `file`, or null.
function rootFor(file, roots) {
  let best = null;
  for (const root of roots) if (isInside(root, file) && (!best || root.length > best.length)) best = root;
  return best;
}

// The environment files of a folder: its own, and those one level down (test/, docs/, …).
function environmentFiles(root, { readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  const files = ENV_FILES.map((name) => path.join(root, name)).filter((f) => exists(f));
  let entries = [];
  try {
    entries = readdir(root, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    for (const name of ENV_FILES) {
      const file = path.join(root, entry.name, name);
      if (exists(file)) files.push(file);
    }
  }
  return files;
}

class EnvironmentWatcher {
  // roots(): the folders that have a server now. onChange(root, changedFiles) is called once the files have stopped
  // changing for `delay` ms (a branch switch rewrites many files at once).
  constructor({ roots, onChange, delay = 1000, timers = require("timers"), readFile, listFiles } = {}) {
    this.roots = roots;
    this.onChange = onChange;
    this.delay = delay;
    this.timers = timers;
    this.readFile = readFile || ((file) => { try { return fs.readFileSync(file, "utf8"); } catch (_) { return null; } });
    this.listFiles = listFiles || environmentFiles;
    // root -> Map(file -> its content when the server started, or null when it did not exist). Changes are always
    // compared with this, so switching to another branch and back reports nothing.
    this.known = new Map();
    this.pending = new Map(); // root -> Set of files that differ from `known` now
    this.timer = null;
  }

  // Records the environment files of `root` as the server sees them now (call it when the server starts).
  remember(root) {
    const files = new Map();
    for (const file of this.listFiles(root)) files.set(file, this.readFile(file));
    this.known.set(root, files);
    this.pending.delete(root);
  }

  // Pulsar's file events: [{ action, path, oldPath }].
  handle(events) {
    const roots = (this.roots() || []).filter((r) => this.known.has(r));
    if (!roots.length) return;
    for (const event of events || []) {
      for (const file of [event.path, event.oldPath]) {
        if (!file || !isEnvironmentFile(file)) continue;
        const root = rootFor(file, roots);
        if (!root) continue;
        if (this.differs(root, file)) {
          if (!this.pending.has(root)) this.pending.set(root, new Set());
          this.pending.get(root).add(file);
        } else {
          const changed = this.pending.get(root); // back to what the server loaded
          if (changed) { changed.delete(file); if (!changed.size) this.pending.delete(root); }
        }
      }
    }
    if (this.pending.size) this.schedule();
  }

  // Whether `file` (in `root`) now differs from when the server started.
  differs(root, file) {
    const files = this.known.get(root);
    const before = files && files.has(file) ? files.get(file) : null;
    return this.readFile(file) !== before;
  }

  schedule() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    this.timer = null;
    const pending = [...this.pending];
    this.pending.clear();
    for (const [root, files] of pending) {
      // Still different from what the server loaded? (A file can change and change back within the delay.)
      const changed = [...files].filter((f) => this.differs(root, f));
      if (changed.length) this.onChange(root, changed.map((f) => path.relative(root, f).split(path.sep).join("/")));
    }
  }

  forget(root) {
    this.known.delete(root);
    this.pending.delete(root);
  }

  dispose() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.known.clear();
    this.pending.clear();
  }
}

module.exports = { EnvironmentWatcher, environmentFiles, isEnvironmentFile, rootFor };
