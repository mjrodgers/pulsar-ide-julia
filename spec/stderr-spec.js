const { createStderrClassifier, createStderrLogger } = require("../lib/stderr");

describe("createStderrClassifier", () => {
  it("files JETLS's startup Info block under debug, as one message", () => {
    const classify = createStderrClassifier();
    const out = classify([
      "┌ Info: Running JETLS with the following setup:",
      "│   Threads.nthreads() = 11",
      "└   JETLS_TEST_MODE = false",
    ].join("\n") + "\n");
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
    expect(classify("┌ Warning: first half\n")[0].level).toBe("warn");
    expect(classify("│   second half\n└ @ Foo\n")[0].level).toBe("warn");
    expect(classify("┌ Info: next thing\n")[0].level).toBe("debug");
  });

  it("keeps a line that is cut between chunks in one piece", () => {
    const classify = createStderrClassifier();
    expect(classify("Stacktrace:\n  [2] resolve_versions!\n    @ /Applications/Julia-1.13.app/Contents/Res")).toEqual([
      { level: "error", text: "Stacktrace:\n  [2] resolve_versions!" },
    ]);
    expect(classify("ources/julia/share/julia/stdlib/v1.13/Pkg/src/Operations.jl:760 [inlined]\n")).toEqual([
      { level: "error", text: "    @ /Applications/Julia-1.13.app/Contents/Resources/julia/share/julia/stdlib/v1.13/Pkg/src/Operations.jl:760 [inlined]" },
    ]);
  });

  it("gives out an unfinished line on flush()", () => {
    const classify = createStderrClassifier();
    expect(classify("Precompiling")).toEqual([]);
    expect(classify.hasPartial()).toBe(true);
    expect(classify.flush()).toEqual([{ level: "debug", text: "Precompiling" }]);
    expect(classify.hasPartial()).toBe(false);
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
    ].join("\n") + "\n");
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

describe("createStderrLogger", () => {
  // A fake clock: specs run timers by hand, so nothing depends on real time.
  function fakeTimers() {
    let next = 1;
    const pending = new Map();
    return {
      setTimeout(fn) { const id = next++; pending.set(id, fn); return id; },
      clearTimeout(id) { pending.delete(id); },
      runAll() { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
      count: () => pending.size,
    };
  }

  it("logs an error and its stack trace, arriving in many small chunks, as one message", () => {
    const timers = fakeTimers();
    const logged = [];
    const logger = createStderrLogger((level, text) => logged.push({ level, text }), { timers });
    for (const chunk of ["┌ Error: Failed to instantiate", " package environment;\n└ @ JETLSCore x.jl:1974\n",
                         "empty intersection between Hecke@0.41.0 and project compatibility 0.41.1 - 0.41\n",
                         "Stacktrace:\n [1]", " resolve_versions!(env)\n   @", " Pkg.Operations Operations.jl:811\n"]) {
      logger.write(chunk);
    }
    expect(logged).toEqual([]);
    timers.runAll();
    expect(logged.length).toBe(1);
    expect(logged[0].level).toBe("error");
    expect(logged[0].text).toContain("Failed to instantiate package environment;");
    expect(logged[0].text).toContain("empty intersection between Hecke@0.41.0");
    expect(logged[0].text).toContain(" [1] resolve_versions!(env)\n   @ Pkg.Operations Operations.jl:811");
  });

  it("holds back an unfinished line while more is arriving, then gives it out", () => {
    const timers = fakeTimers();
    const logged = [];
    const logger = createStderrLogger((level, text) => logged.push({ level, text }), { timers });
    logger.write("┌ Warning: done\n└ @ X\nhalf a li");
    timers.runAll();
    expect(logged).toEqual([{ level: "warn", text: "┌ Warning: done\n└ @ X" }]);
    expect(timers.count()).toBe(1); // checks again later for the rest of the line
    timers.runAll(); // nothing more arrived: the unfinished line is logged as it is
    expect(logged[1]).toEqual({ level: "debug", text: "half a li" });
    expect(timers.count()).toBe(0);
  });

  it("logs everything on flush(), and dispose() cancels its timer", () => {
    const timers = fakeTimers();
    const logged = [];
    const logger = createStderrLogger((level, text) => logged.push({ level, text }), { timers });
    logger.write("ERROR: boom");
    logger.flush();
    expect(logged).toEqual([{ level: "error", text: "ERROR: boom" }]);
    logger.write("more\n");
    logger.dispose();
    expect(timers.count()).toBe(0);
  });
});
