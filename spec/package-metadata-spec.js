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

  it("gives every setting a unique order", () => {
    const orders = Object.values(readJson("package.json").configSchema).map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("declares a default for every debugger setting the controller reads", () => {
    const schema = readJson("package.json").configSchema;
    const read = ["debugJuliaPath", "debugEnvironment", "debugThreads", "debugFlags", "debugStopOnEntry", "debugLaunchArgumentsJson", "debugExceptionFilters", "debugOpenWorkspace", "debugOpenOutput", "debugProgramArguments", "debugCompiledMode", "debugCompiledModules"];
    for (const key of read) expect(schema[key] && "default" in schema[key]).toBe(true);
  });
});
