// Things that must agree across package.json, the keymap and the code, checked without Pulsar.
// Files are read inside the specs (not at load time) so a missing file fails one spec with a clear
// message instead of aborting the whole run.
const fs = require("fs");
const path = require("path");
const { createDebugAdapterProvider } = require("../lib/debug/provider");

const root = path.join(__dirname, "..");
const readJson = (...parts) => {
  const file = path.join(root, ...parts);
  if (!fs.existsSync(file)) throw new Error(`${parts.join("/")} is missing from the package (looked in ${file})`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

describe("package metadata", () => {
  it("provides the debug-adapter service, and leaves the debugger's commands to pulsar-ide-debugger", () => {
    const pkg = readJson("package.json");
    expect(pkg.providedServices["debug-adapter"].versions["0.1.0"]).toBe("provideDebugAdapter");
    const activation = pkg.activationCommands["atom-workspace"];
    expect(activation.filter((c) => /:(debug-|toggle-breakpoint|clear-breakpoints|open-workspace)/.test(c))).toEqual([]);
  });

  it("only binds keys to commands that are activation commands", () => {
    const activation = readJson("package.json").activationCommands["atom-workspace"];
    const keymap = readJson("keymaps", "pulsar-ide-julia.json");
    for (const bindings of Object.values(keymap)) {
      for (const command of Object.values(bindings)) expect(activation).toContain(command);
    }
  });

  // "repl.threads" -> the schema entry of that setting, or undefined.
  const schemaAt = (schema, keyPath) => keyPath.split(".").reduce(
    (node, key, i) => node && (i === 0 ? node[key] : node.properties && node.properties[key]), schema);

  it("gives every group, and every setting in a group, a unique order", () => {
    const schema = readJson("package.json").configSchema;
    const unique = (list) => expect(new Set(list).size).toBe(list.length);
    unique(Object.values(schema).map((g) => g.order));
    for (const group of Object.values(schema)) {
      expect(group.type).toBe("object");
      unique(Object.values(group.properties).map((s) => s.order));
    }
  });

  it("has every setting the old names moved to, and every added one, with a default", () => {
    const schema = readJson("package.json").configSchema;
    const { MOVED, ADDED, RESTART_KEYS } = require("../lib/config-keys");
    for (const keyPath of [...Object.values(MOVED), ...ADDED, ...RESTART_KEYS]) {
      const entry = schemaAt(schema, keyPath);
      expect(entry && "default" in entry ? keyPath : `${keyPath} is missing`).toBe(keyPath);
    }
    const count = Object.values(schema).reduce((n, g) => n + Object.keys(g.properties).length, 0);
    expect(count).toBe(Object.keys(MOVED).length + ADDED.length);
  });

  it("lists every test command in activationCommands", () => {
    const activation = readJson("package.json").activationCommands["atom-workspace"];
    const { TestController } = require("../lib/tests");
    for (const name of Object.keys(new TestController({}).commandTable())) expect(activation).toContain(`pulsar-ide-julia:${name}`);
  });

  it("declares a default for every setting the debug adapter provider reads", () => {
    const schema = readJson("package.json").configSchema;
    const read = new Set();
    const provider = createDebugAdapterProvider({ setting: (key) => { read.add(key); return undefined; } });
    provider.launchRequest({ file: "/work/a.jl" });
    provider.exceptionFilters();
    provider.explainFailure({ message: "x" });
    expect(read.size).toBeGreaterThan(5);
    for (const key of [...read, "repl.workspace"]) expect(schemaAt(schema, key) && "default" in schemaAt(schema, key) ? key : `${key} has no default`).toBe(key);
  });
});
