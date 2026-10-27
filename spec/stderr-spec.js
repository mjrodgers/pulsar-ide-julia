const { createStderrClassifier } = require("../lib/stderr");

describe("createStderrClassifier", () => {
  it("files JETLS's startup Info block under debug, as one message", () => {
    const classify = createStderrClassifier();
    const out = classify([
      "┌ Info: Running JETLS with the following setup:",
      "│   Threads.nthreads() = 11",
      "└   JETLS_TEST_MODE = false",
    ].join("\n"));
    expect(out.length).toBe(1);
    expect(out[0].level).toBe("debug");
    expect(out[0].text).toContain("JETLS_TEST_MODE");
  });

  it("keeps Warning and Error blocks visible", () => {
    const classify = createStderrClassifier();
    const out = classify("┌ Warning: something odd\n└ @ Foo path\n┌ Error: broke\n│ detail\n└ @ Bar path\n");
    expect(out.map((g) => g.level)).toEqual(["warn", "error"]);
  });

  it("treats uncaught Julia errors and stack traces as errors", () => {
    const classify = createStderrClassifier();
    const out = classify("ERROR: LoadError: boom\nStacktrace:\n  [1] error(s::String)\n    @ Base ./error.jl:35\n");
    expect(out.length).toBe(1);
    expect(out[0].level).toBe("error");
  });

  it("follows a block that arrives split across chunks", () => {
    const classify = createStderrClassifier();
    expect(classify("┌ Warning: first half")[0].level).toBe("warn");
    expect(classify("│   second half\n└ @ Foo")[0].level).toBe("warn");
    expect(classify("┌ Info: next thing")[0].level).toBe("debug");
  });

  it("does not let an Info block following an error inherit its level", () => {
    const classify = createStderrClassifier();
    const out = classify("┌ Error: bad\n└ @ X\n┌ Info: fine\n└ @ Y\n");
    expect(out.map((g) => g.level)).toEqual(["error", "debug"]);
  });

  it("treats plain, unmarked lines as debug and skips blank ones", () => {
    const classify = createStderrClassifier();
    expect(classify("Precompiling packages...\n\n")).toEqual([{ level: "debug", text: "Precompiling packages..." }]);
  });
});
