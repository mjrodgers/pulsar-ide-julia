const { fuzzyMatch } = require("../lib/fuzzy");

describe("fuzzyMatch", () => {
  it("matches subsequences, ignoring case", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
    expect(fuzzyMatch("xs", "xValues")).toBe(true);
    expect(fuzzyMatch("VAL", "xvalues")).toBe(true);
    expect(fuzzyMatch("sx", "xs")).toBe(false);
    expect(fuzzyMatch("q", "xs")).toBe(false);
  });
});
