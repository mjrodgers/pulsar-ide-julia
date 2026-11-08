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

  it("keeps the exception JETLS prints after an Error block visible, up to the next block", () => {
    // What JETLS prints when instantiating a package fails: Pkg's message has no "ERROR:" prefix.
    const classify = createStderrClassifier();
    const out = classify([
      "┌ Error: Failed to instantiate package environment;",
      "│   env_path = \"/x/Oscar/Project.toml\"",
      "└ @ JETLSCore ~/.julia/packages/JETLSCore/QR1oi/src/analysis/full-analysis.jl:1974",
      "",
      "Unsatisfiable requirements detected for package Hecke [3e1990a7]:",
      " Hecke [3e1990a7] log:",
      " ├─possible versions are: 0.39.0 - 0.40.5 or uuid 3e1990a7",
      "",
      "Stacktrace:",
      "  [1] resolve(...)",
      "┌ Info: next thing",
      "└ @ Y",
      "Precompiling packages...",
    ].join("\n"));
    expect(out.map((g) => g.level)).toEqual(["error", "debug"]);
    expect(out[0].text).toContain("Unsatisfiable requirements detected for package Hecke");
    expect(out[0].text).toContain("Stacktrace:");
    expect(out[1].text).toContain("Precompiling packages...");
  });

  it("keeps the lines after an Error block visible when they arrive in a later chunk", () => {
    const classify = createStderrClassifier();
    classify("┌ Error: broke\n└ @ X\n");
    expect(classify("\nSome PkgError message\n")).toEqual([{ level: "error", text: "Some PkgError message" }]);
  });

  it("treats plain, unmarked lines as debug and skips blank ones", () => {
    const classify = createStderrClassifier();
    expect(classify("Precompiling packages...\n\n")).toEqual([{ level: "debug", text: "Precompiling packages..." }]);
  });
});
