// These specs use the Jasmine 2 API (spyOn().and.*, async/await). Under the default
// Jasmine 1.3 runner they fail in confusing ways, so fail clearly and first.
describe("test runner", () => {
  it("is Jasmine 2 or newer (set atomTestRunner in package.json)", () => {
    const env = jasmine.getEnv();
    const version = String(jasmine.version || (env.versionString && env.versionString()) || "0");
    expect(Number(version.split(".")[0])).toBeGreaterThan(1);
  });
});
