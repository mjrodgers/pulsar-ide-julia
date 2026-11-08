const path = require("path");
const { EnvironmentWatcher, environmentFiles, isEnvironmentFile, rootFor } = require("../lib/server/env-watch");

// A fake clock: specs run the watcher's timer by hand.
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    runAll() { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
    count: () => pending.size,
  };
}

const ROOT = path.join(path.sep, "work", "Oscar");
const OTHER = path.join(path.sep, "work", "Hecke");
const at = (...parts) => path.join(ROOT, ...parts);

// A watcher over an in-memory file system: `files` maps paths to contents.
function setup({ roots = [ROOT, OTHER] } = {}) {
  const files = new Map([
    [at("Project.toml"), "[compat]\nAbstractAlgebra = \"0.51.3\"\n"],
    [at("test", "Project.toml"), "[deps]\nTest = \"…\"\n"],
    [path.join(OTHER, "Project.toml"), "name = \"Hecke\"\n"],
  ]);
  const timers = fakeTimers();
  const changes = [];
  const watcher = new EnvironmentWatcher({
    roots: () => roots,
    onChange: (root, changed) => changes.push({ root, changed }),
    timers,
    readFile: (file) => (files.has(file) ? files.get(file) : null),
    listFiles: (root) => [...files.keys()].filter((f) => f.startsWith(root + path.sep)),
  });
  return { files, timers, changes, watcher };
}

describe("EnvironmentWatcher", () => {
  it("reports a folder whose Project.toml changed since its server started, once the changes settle", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    // A branch switch: the project file changes, along with many source files.
    files.set(at("Project.toml"), "[compat]\nAbstractAlgebra = \"0.50.2\"\n");
    watcher.handle([{ action: "modified", path: at("src", "Oscar.jl") }, { action: "modified", path: at("Project.toml") }]);
    expect(changes).toEqual([]);
    watcher.handle([{ action: "modified", path: at("src", "Rings.jl") }]);
    timers.runAll();
    expect(changes).toEqual([{ root: ROOT, changed: ["Project.toml"] }]);
  });

  it("reports nothing when a branch switch leaves Project.toml as it was", () => {
    const { timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    // git rewrites the file with the same content (a rebased working branch)
    watcher.handle([{ action: "modified", path: at("Project.toml") }, { action: "modified", path: at("src", "Oscar.jl") }]);
    timers.runAll();
    expect(changes).toEqual([]);
    expect(timers.count()).toBe(0);
  });

  it("reports nothing after switching to another branch and back before the changes settle", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    const original = files.get(at("Project.toml"));
    files.set(at("Project.toml"), "changed");
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    files.set(at("Project.toml"), original);
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    timers.runAll();
    expect(changes).toEqual([]);
  });

  it("compares with what the server started with, not with the last change", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    const original = files.get(at("Project.toml"));
    files.set(at("Project.toml"), "older branch");
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    timers.runAll();
    expect(changes.length).toBe(1);
    // The user does not restart and switches back: the server's environment matches again.
    files.set(at("Project.toml"), original);
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    timers.runAll();
    expect(changes.length).toBe(1);
  });

  it("starts comparing afresh after the server restarts", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    files.set(at("Project.toml"), "older branch");
    watcher.remember(ROOT); // the restarted server loaded this one
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    timers.runAll();
    expect(changes).toEqual([]);
  });

  it("reports subfolder environments, new and deleted project files, by folder", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    watcher.remember(OTHER);
    files.set(at("test", "Project.toml"), "[deps]\nTest = \"…\"\nAqua = \"…\"\n");
    files.set(at("docs", "Project.toml"), "[deps]\nDocumenter = \"…\"\n");
    files.delete(path.join(OTHER, "Project.toml"));
    watcher.handle([
      { action: "modified", path: at("test", "Project.toml") },
      { action: "created", path: at("docs", "Project.toml") },
      { action: "deleted", path: path.join(OTHER, "Project.toml") },
    ]);
    timers.runAll();
    expect(changes).toEqual([
      { root: ROOT, changed: ["test/Project.toml", "docs/Project.toml"] },
      { root: OTHER, changed: ["Project.toml"] },
    ]);
  });

  it("ignores manifests, other files, folders without a server, and folders it was not told about", () => {
    const { files, timers, changes, watcher } = setup({ roots: [ROOT] });
    watcher.remember(ROOT);
    files.set(at("Manifest.toml"), "written by JETLS while instantiating");
    files.set(path.join(OTHER, "Project.toml"), "changed");
    files.set(path.join(path.sep, "elsewhere", "Project.toml"), "changed");
    watcher.handle([
      { action: "modified", path: at("Manifest.toml") },
      { action: "modified", path: path.join(OTHER, "Project.toml") }, // its server is not running
      { action: "modified", path: path.join(path.sep, "elsewhere", "Project.toml") },
    ]);
    timers.runAll();
    expect(changes).toEqual([]);
  });

  it("reports nothing before remember() or after forget() and dispose()", () => {
    const { files, timers, changes, watcher } = setup();
    files.set(at("Project.toml"), "changed");
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    watcher.remember(OTHER);
    watcher.forget(OTHER);
    files.set(path.join(OTHER, "Project.toml"), "changed");
    watcher.handle([{ action: "modified", path: path.join(OTHER, "Project.toml") }]);
    timers.runAll();
    expect(changes).toEqual([]);
    watcher.remember(ROOT);
    files.set(at("Project.toml"), "changed again");
    watcher.handle([{ action: "modified", path: at("Project.toml") }]);
    watcher.dispose();
    expect(timers.count()).toBe(0);
  });

  it("follows a renamed project file through its old path", () => {
    const { files, timers, changes, watcher } = setup();
    watcher.remember(ROOT);
    files.set(at("JuliaProject.toml"), files.get(at("Project.toml")));
    files.delete(at("Project.toml"));
    watcher.handle([{ action: "renamed", path: at("JuliaProject.toml"), oldPath: at("Project.toml") }]);
    timers.runAll();
    expect(changes).toEqual([{ root: ROOT, changed: ["JuliaProject.toml", "Project.toml"] }]);
  });
});

describe("environment file helpers", () => {
  it("recognizes project files only", () => {
    expect(isEnvironmentFile(at("Project.toml"))).toBe(true);
    expect(isEnvironmentFile(at("test", "JuliaProject.toml"))).toBe(true);
    expect(isEnvironmentFile(at("Manifest.toml"))).toBe(false);
    expect(isEnvironmentFile(at("src", "Project.jl"))).toBe(false);
  });

  it("picks the deepest folder that contains a file", () => {
    const nested = path.join(ROOT, "experimental", "Pkg");
    expect(rootFor(path.join(nested, "Project.toml"), [ROOT, nested])).toBe(nested);
    expect(rootFor(at("Project.toml"), [ROOT, nested])).toBe(ROOT);
    expect(rootFor(path.join(path.sep, "work", "OscarExtra", "Project.toml"), [ROOT])).toBe(null);
  });

  it("lists a folder's project files and those one level down, skipping hidden folders", () => {
    const dirs = { [ROOT]: ["src", "test", "docs", ".git", "node_modules"] };
    const exists = new Set([at("Project.toml"), at("test", "Project.toml"), at("docs", "Project.toml"), at(".git", "Project.toml")]);
    const readdir = (dir) => (dirs[dir] || []).map((name) => ({ name, isDirectory: () => true }));
    expect(environmentFiles(ROOT, { readdir, exists: (f) => exists.has(f) }))
      .toEqual([at("Project.toml"), at("test", "Project.toml"), at("docs", "Project.toml")]);
    expect(environmentFiles(path.join(path.sep, "missing"), { readdir: () => { throw new Error("ENOENT"); }, exists: () => false })).toEqual([]);
  });
});
