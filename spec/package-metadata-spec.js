// Things that must agree across package.json, the keymap and the code, checked without Pulsar.
// Files are read inside the specs (not at load time) so a missing file fails one spec with a clear
// message instead of aborting the whole run.
const fs = require("fs");
const path = require("path");
const { DebugController } = require("../lib/debug/controller");

const root = path.join(__dirname, "..");
const readJson = (...parts) => {
  const file = path.join(root, ...parts);
  if (!fs.existsSync(file)) throw new Error(`${parts.join("/")} is missing from the package (looked in ${file})`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

describe("package metadata", () => {
  it("lists every debugger command in activationCommands", () => {
    const activation = readJson("package.json").activationCommands["atom-workspace"];
    const controller = new DebugController({ setting: () => undefined, notifications: {}, ui: {} });
    for (const name of Object.keys(controller.commandTable())) expect(activation).toContain(`pulsar-ide-julia:${name}`);
    controller.unsubscribeStore();
    controller.unsubscribeLog();
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

  it("declares a default for every debugger setting the controller reads", () => {
    const schema = readJson("package.json").configSchema;
    const read = ["debugger.juliaPath", "debugger.environment", "debugger.threads", "debugger.flags", "debugger.stopOnEntry", "debugger.launchArgumentsJson", "debugger.exceptionFilters", "debugger.openWorkspace", "debugger.openOutput", "debugger.programArguments", "debugger.compiledMode", "debugger.compiledModules", "repl.workspace"];
    for (const key of read) expect(schemaAt(schema, key) && "default" in schemaAt(schema, key)).toBe(true);
  });
});
