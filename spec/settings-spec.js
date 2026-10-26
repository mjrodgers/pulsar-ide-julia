const { buildJetlsSettings, deepMerge, parseJsonObject } = require("../lib/settings");

describe("buildJetlsSettings", () => {
  it("sends nothing when everything is at JETLS's defaults", () => {
    const { settings, errors } = buildJetlsSettings({ autoInstantiate: "prompt", debounce: 1.0, formatter: "Runic", settingsJson: "{}" });
    expect(settings).toEqual({});
    expect(errors).toEqual([]);
  });

  it("maps first-class settings to JETLS keys when non-default", () => {
    const { settings } = buildJetlsSettings({ autoInstantiate: "never", debounce: 2.5, formatter: "JuliaFormatter" });
    expect(settings).toEqual({ full_analysis: { auto_instantiate: "never", debounce: 2.5 }, formatter: "JuliaFormatter" });
  });

  it("merges the JSON field over first-class settings", () => {
    const { settings } = buildJetlsSettings({
      debounce: 2.0,
      settingsJson: JSON.stringify({ full_analysis: { auto_instantiate: "always" }, code_lens: { references: true } }),
    });
    expect(settings).toEqual({ full_analysis: { debounce: 2.0, auto_instantiate: "always" }, code_lens: { references: true } });
  });

  it("lets the JSON field replace the formatter string with a custom table", () => {
    const { settings } = buildJetlsSettings({ formatter: "JuliaFormatter", settingsJson: '{"formatter":{"custom":{"executable":"/x"}}}' });
    expect(settings.formatter).toEqual({ custom: { executable: "/x" } });
  });

  it("reports invalid JSON and still returns the other settings", () => {
    const { settings, errors } = buildJetlsSettings({ formatter: "JuliaFormatter", settingsJson: "{oops" });
    expect(settings).toEqual({ formatter: "JuliaFormatter" });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("not valid JSON");
  });

  it("rejects JSON that is not an object", () => {
    expect(parseJsonObject("[1,2]", "X").error).toContain("must be a JSON object");
  });
});

describe("deepMerge", () => {
  it("merges objects recursively but replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({ a: { b: 1, c: [2], d: 3 } });
  });
});
