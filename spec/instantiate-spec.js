const {
  envPathFromWarning, parseJuliaString, createFailureWatcher, shortReason, fixedPackageFrom, recoveryActions,
  describeFailure, actionArgs, actionCommand,
} = require("../lib/server/instantiate");

// What JETLS printed for the Oscar branch (from the developer console), with the stack trace cut short.
const OSCAR_STDERR = [
  "┌ Error: Failed to instantiate package environment;",
  "│ Unable to instantiate the environment of the target package for analysis,",
  "│ so this package will be analyzed as a script instead.",
  "│ This may cause various features such as diagnostics to not function properly.",
  "│ It is recommended to fix the problem by referring to the following error",
  "│   env_path = \"/Users/me/github/OSCAR Project/Oscar/Project.toml\"",
  "└ @ JETLSCore ~/.julia/packages/JETLSCore/QR1oi/src/analysis/full-analysis.jl:1974",
  "  Resolving package versions...",
  "empty intersection between Hecke@0.41.0 and project compatibility 0.41.1 - 0.41",
  "",
  "Stacktrace:",
  "  [1] resolve_versions!(env::Pkg.Types.EnvCache, …)",
  "    @ Pkg.Operations /Applications/Julia-1.13.app/Contents/Resources/julia/share/julia/stdlib/v1.13/Pkg/src/Operations.jl:811",
].join("\n");

const OSCAR_ENV = "/Users/me/github/OSCAR Project/Oscar/Project.toml";
const OSCAR_REASON = "  Resolving package versions...\nempty intersection between Hecke@0.41.0 and project compatibility 0.41.1 - 0.41";

describe("instantiation failures", () => {
  it("recognizes JETLS's warning and reads the environment from it", () => {
    const message = `Failed to instantiate package environment at ${OSCAR_ENV}.\n` +
      "The package will be analyzed as a script, which may result in incomplete diagnostics.\nSee the language server log for details.";
    expect(envPathFromWarning(message)).toBe(OSCAR_ENV);
    expect(envPathFromWarning("Some other message")).toBe(null);
    expect(envPathFromWarning(undefined)).toBe(null);
  });

  it("reads Julia string literals as repr prints them", () => {
    expect(parseJuliaString('"C:\\\\Users\\\\me\\\\Project.toml"')).toBe("C:\\Users\\me\\Project.toml");
    expect(parseJuliaString('"a \\"quoted\\" \\$name"')).toBe('a "quoted" $name');
    expect(parseJuliaString("not a string")).toBe(null);
  });

  it("collects the environment and the reason from JETLS's stderr", () => {
    const failures = [];
    createFailureWatcher((f) => failures.push(f))(OSCAR_STDERR);
    expect(failures).toEqual([{ envPath: OSCAR_ENV, reason: OSCAR_REASON }]);
  });

  it("follows the output when it arrives in several messages", () => {
    const failures = [];
    const feed = createFailureWatcher((f) => failures.push(f));
    const lines = OSCAR_STDERR.split("\n");
    feed(lines.slice(0, 6).join("\n"));
    feed(lines.slice(6, 9).join("\n"));
    expect(failures).toEqual([]);
    feed(lines.slice(9).join("\n"));
    expect(failures.length).toBe(1);
    expect(failures[0].reason).toContain("empty intersection between Hecke@0.41.0");
  });

  it("ignores other error blocks, and ends a failure at the next block when there is no stack trace", () => {
    const failures = [];
    const feed = createFailureWatcher((f) => failures.push(f));
    feed("┌ Error: something else\n│   env_path = \"/x/Project.toml\"\n└ @ X\nnot a reason\nStacktrace:\n");
    expect(failures).toEqual([]);
    feed("┌ Error: Failed to instantiate package environment;\n│   env_path = \"/y/Project.toml\"\n└ @ X\nPkgError text\n┌ Info: next\n");
    expect(failures).toEqual([{ envPath: "/y/Project.toml", reason: "PkgError text" }]);
  });

  it("recognizes a dependency at a version the project no longer allows, and where that version comes from", () => {
    expect(fixedPackageFrom(OSCAR_REASON))
      .toEqual({ name: "Hecke", version: "0.41.0", origin: null, compat: "0.41.1 - 0.41", notFromRegistry: false });
    expect(fixedPackageFrom("empty intersection between Hecke@0.41.0 (recorded in the manifest) and project compatibility 0.41.1 - 0.41").notFromRegistry)
      .toBe(false);
    expect(fixedPackageFrom("empty intersection between Hecke@0.41.0 (version of the developed package at ~/dev/Hecke) and project compatibility 0.41.1 - 0.41"))
      .toEqual({ name: "Hecke", version: "0.41.0", origin: "version of the developed package at ~/dev/Hecke", compat: "0.41.1 - 0.41", notFromRegistry: true });
    expect(fixedPackageFrom("empty intersection between Hecke@0.41.0 (pinned in the manifest) and project compatibility 0.41.1 - 0.41").notFromRegistry)
      .toBe(true);
    expect(fixedPackageFrom("Unsatisfiable requirements detected for package Nemo [2edaba10]:")).toBe(null);
  });

  it("offers to update a dependency the manifest holds at a version the project no longer allows", () => {
    // What happened with the Oscar branch: `]up` in the project fixed it.
    const actions = recoveryActions(OSCAR_REASON);
    expect(actions.map((a) => a.id)).toEqual(["update-one", "update", "retry"]);
    expect(actions[0].title).toBe("Update Hecke and retry");
    expect(actions[0].code).toBe('using Pkg; Pkg.update("Hecke"); Pkg.instantiate()');
    expect(actions[2].code).toBeUndefined();
  });

  it("offers the released version of a developed or pinned dependency, or a retry after fixing it by hand", () => {
    const actions = recoveryActions("empty intersection between Hecke@0.41.0 (version of the developed package at ~/dev/Hecke) and project compatibility 0.41.1 - 0.41");
    expect(actions.map((a) => a.id)).toEqual(["free", "retry"]);
    expect(actions[0].title).toBe("Use released Hecke and retry");
    expect(actions[0].code).toBe('using Pkg; Pkg.free("Hecke"); Pkg.update("Hecke"); Pkg.instantiate()');
  });

  it("otherwise offers a registry update, a full update, or a retry", () => {
    const actions = recoveryActions("Unsatisfiable requirements detected for package Nemo [2edaba10]:");
    expect(actions.map((a) => a.id)).toEqual(["registry", "update", "retry"]);
    expect(actions[0].code).toBe("using Pkg; Pkg.Registry.update(); Pkg.resolve(); Pkg.instantiate()");
    expect(actions[1].code).toBe("using Pkg; Pkg.update(); Pkg.instantiate()");
    expect(recoveryActions("").map((a) => a.id)).toEqual(["registry", "update", "retry"]);
  });

  it("explains the failure with the end of the reason", () => {
    const text = describeFailure({ reason: OSCAR_REASON });
    expect(text).toContain("```\n  Resolving package versions...\nempty intersection between Hecke@0.41.0");
    expect(text).toContain("The environment has `Hecke` 0.41.0, but the project now needs 0.41.1 - 0.41");
    expect(text).toContain("**Update Hecke**");
    const noReason = describeFailure({ reason: "" });
    expect(noReason).toContain("developer console");
    expect(noReason).toContain("**Update registry and retry**");
  });

  it("keeps the reason short", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const short = shortReason(long, 5);
    expect(short.split("\n")).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
  });

  it("runs Pkg in the environment's folder, without the user's startup file", () => {
    expect(actionArgs(OSCAR_ENV, "using Pkg")).toEqual(["--startup-file=no", "--project=/Users/me/github/OSCAR Project/Oscar", "-e", "using Pkg"]);
    expect(actionArgs("/x/Oscar", "using Pkg")[1]).toBe("--project=/x/Oscar");
    expect(actionCommand(OSCAR_ENV, "using Pkg; Pkg.resolve()"))
      .toBe("julia \"--project=/Users/me/github/OSCAR Project/Oscar\" -e 'using Pkg; Pkg.resolve()'");
  });
});
