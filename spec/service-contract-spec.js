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
