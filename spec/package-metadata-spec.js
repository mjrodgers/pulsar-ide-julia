// Things that must agree across package.json, the keymap and the code, checked without Pulsar.
const fs = require("fs");
const path = require("path");
const { DebugController } = require("../lib/debug/controller");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const keymap = JSON.parse(fs.readFileSync(path.join(root, "keymaps", "pulsar-ide-julia.json"), "utf8"));
const activation = pkg.activationCommands["atom-workspace"];

describe("package metadata", () => {
  it("lists every debugger command in activationCommands", () => {
    const controller = new DebugController({ setting: () => undefined, notifications: {}, ui: {} });
    for (const name of Object.keys(controller.commandTable())) expect(activation).toContain(`pulsar-ide-julia:${name}`);
    controller.unsubscribeStore();
    controller.unsubscribeLog();
  });

  it("only binds keys to commands that are activation commands", () => {
    for (const bindings of Object.values(keymap)) {
      for (const command of Object.values(bindings)) expect(activation).toContain(command);
    }
  });

  it("gives every setting a unique order", () => {
    const orders = Object.values(pkg.configSchema).map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("declares a default for every debugger setting the controller reads", () => {
    const read = ["debugJuliaPath", "debugEnvironment", "debugThreads", "debugFlags", "debugStopOnEntry", "debugLaunchArgumentsJson", "debugExceptionFilters", "debugOpenWorkspace", "debugOpenOutput", "debugProgramArguments", "debugCompiledMode", "debugCompiledModules"];
    for (const key of read) expect(pkg.configSchema[key] && "default" in pkg.configSchema[key]).toBe(true);
  });
});
