// Cheap but valuable: every service method named in package.json must exist
// on the client. Catches typos and names that differ in the fork.
const pkg = require("../package.json");

describe("service contract", () => {
  let client;
  beforeEach(() => { client = require("../lib/main"); });

  const methodsFor = (section) =>
    Object.entries(pkg[section] || {}).flatMap(([service, def]) =>
      Object.values(def.versions).map((method) => ({ service, method })));

  for (const section of ["providedServices", "consumedServices"]) {
    it(`implements every method named in ${section}`, () => {
      const missing = methodsFor(section)
        .filter(({ method }) => typeof client[method] !== "function")
        .map(({ service, method }) => `${service} -> ${method}`);
      expect(missing).toEqual([]);
    });
  }

  it("targets the Julia grammar scope", () => {
    expect(client.getGrammarScopes()).toEqual(["source.julia"]);
  });
});

describe("activation hook", () => {
  it("matches the hook the specs trigger", () => {
    const { ACTIVATION_HOOK } = require("./helpers/activate");
    expect(pkg.activationHooks).toContain(ACTIVATION_HOOK);
  });
});

describe("a failed format", () => {
  let client;
  beforeEach(() => {
    client = require("../lib/main");
    client.formatNotices = new Map();
    spyOn(atom.notifications, "addError").and.callFake(() => ({ isDismissed: () => false }));
  });

  it("is shown once while its notification is up, and formats nothing", async () => {
    const missing = () => Promise.reject(Object.assign(new Error("`jlfmt` executable is not found on the `PATH`."), { code: -32803 }));
    expect(await client.reportingFormatFailures(missing)).toEqual([]);
    expect(await client.reportingFormatFailures(missing)).toEqual([]);
    expect(atom.notifications.addError.calls.count()).toBe(1);
    expect(atom.notifications.addError.calls.argsFor(0)[0]).toMatch(/`jlfmt` is not installed/);
  });

  it("passes the edits through when formatting works, and says nothing about a cancelled request", async () => {
    expect(await client.reportingFormatFailures(async () => ["edit"])).toEqual(["edit"]);
    await client.reportingFormatFailures(() => Promise.reject(Object.assign(new Error("cancelled"), { code: -32800 })));
    expect(atom.notifications.addError).not.toHaveBeenCalled();
  });
});
