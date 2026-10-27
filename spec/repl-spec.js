const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSymbolDump } = require("./helpers/symbol-dump");
const {
  quoteArg, findProjectDir, buildReplCommand, includeCommand, activateCommand, codeToCommands,
  isCellMarker, findCell, nextCellMarkerRow, previousCellMarkerRow, findDefinition,
} = require("../lib/repl");

describe("quoteArg", () => {
  it("leaves plain arguments alone and single-quotes anything else on POSIX", () => {
    expect(quoteArg("/usr/bin/julia", "linux")).toBe("/usr/bin/julia");
    expect(quoteArg("auto", "linux")).toBe("auto");
    expect(quoteArg("/Users/Jane Doe/proj", "darwin")).toBe("'/Users/Jane Doe/proj'");
    expect(quoteArg("it's", "linux")).toBe("'it'\\''s'");
  });

  it("double-quotes on Windows", () => {
    expect(quoteArg("C:\\Program Files\\Julia\\bin\\julia.exe", "win32")).toBe('"C:\\Program Files\\Julia\\bin\\julia.exe"');
  });
});

describe("findProjectDir", () => {
  it("walks up to the nearest Project.toml", () => {
    const exists = (p) => p === path.resolve("/a/b/Project.toml");
    expect(findProjectDir("/a/b/c/d", exists)).toBe(path.resolve("/a/b"));
  });

  it("accepts JuliaProject.toml, and returns null when there is none", () => {
    expect(findProjectDir("/a/b", (p) => p === path.resolve("/a/JuliaProject.toml"))).toBe(path.resolve("/a"));
    expect(findProjectDir("/a/b", () => false)).toBeNull();
    expect(findProjectDir(null, () => true)).toBeNull();
  });

  it("works against the real file system", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "julia-proj-"));
    try {
      fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Project.toml"), "name = \"X\"\n");
      expect(findProjectDir(path.join(dir, "src", "deep"))).toBe(fs.realpathSync(dir) === dir ? dir : path.resolve(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReplCommand", () => {
  const build = (o) => buildReplCommand({ platform: "linux", homedir: "/home/u", ...o });

  it("defaults to plain julia", () => {
    expect(build({})).toBe("julia");
  });

  it("uses the Julia path (with ~ expanded and quoting), threads and the file's project", () => {
    expect(build({ juliaPath: "~/julia 1.12/bin/julia", threads: "auto", projectDir: "/work/My Pkg" }))
      .toBe("'/home/u/julia 1.12/bin/julia' --threads=auto --project='/work/My Pkg'");
  });

  it("an explicit environment wins over the file's project; @-names are kept verbatim", () => {
    expect(build({ environment: "@.", projectDir: "/work/p" })).toBe("julia --project=@.");
    expect(build({ environment: "~/envs/a", projectDir: "/work/p" })).toBe("julia --project=/home/u/envs/a");
  });

  it("appends extra flags as written, adding -i when -e/--eval would otherwise exit", () => {
    expect(build({ flags: "--color=yes" })).toBe("julia --color=yes");
    expect(build({ flags: "-e 'using Revise'" })).toBe("julia -i -e 'using Revise'");
    expect(build({ flags: "--eval 'using Revise'" })).toBe("julia -i --eval 'using Revise'");
    expect(build({ flags: "-i -e 'using Revise'" })).toBe("julia -i -e 'using Revise'");
    expect(build({ flags: "--interactive -e 'x'" })).toBe("julia --interactive -e 'x'");
  });
});

describe("Julia snippets", () => {
  it("builds include and activate commands with raw strings", () => {
    expect(includeCommand("/a/b.jl")).toBe('include(raw"/a/b.jl")');
    expect(includeCommand('/a/"q".jl')).toBe('include(raw"/a/\\"q\\".jl")');
    expect(activateCommand("/work/pkg")).toBe('import Pkg; Pkg.activate(raw"/work/pkg")');
  });
});

describe("codeToCommands", () => {
  it("types one command per line, dropping trailing blank space", () => {
    expect(codeToCommands("a = 1\nb = 2\n\n")).toEqual(["a = 1", "b = 2"]);
    expect(codeToCommands("a = 1\r\nb = 2")).toEqual(["a = 1", "b = 2"]);
  });

  it("keeps blank lines inside a block", () => {
    expect(codeToCommands("function f()\n\n  1\nend")).toEqual(["function f()", "", "  1", "end"]);
  });

  it("can wrap everything in one bracketed paste", () => {
    expect(codeToCommands("a\nb", { bracketedPaste: true })).toEqual(["\u001b[200~a\nb\u001b[201~"]);
  });

  it("returns nothing for empty input", () => {
    expect(codeToCommands("")).toEqual([]);
    expect(codeToCommands("  \n ")).toEqual([]);
  });
});

describe("cells", () => {
  const lines = ["## first", "x = 1", "y = 2", "", "## second", "function f(a)", "  a", "end", "", "# %% third", "f(x)", ""];

  it("recognizes Juno's markers", () => {
    for (const m of ["## a", "#--- b", "# %% c", "  ## indented"]) expect(isCellMarker(m)).toBe(true);
    for (const m of ["# comment", "x = 1 ## trailing", "#hello"]) expect(isCellMarker(m)).toBe(false);
  });

  it("finds the cell around a row, without trailing blank lines", () => {
    expect(findCell(lines, 1)).toEqual({ startRow: 0, endRow: 2, nextCellRow: 4 });
    expect(findCell(lines, 3)).toEqual({ startRow: 0, endRow: 2, nextCellRow: 4 });
    expect(findCell(lines, 4)).toEqual({ startRow: 4, endRow: 7, nextCellRow: 9 });
    expect(findCell(lines, 6)).toEqual({ startRow: 4, endRow: 7, nextCellRow: 9 });
    expect(findCell(lines, 10)).toEqual({ startRow: 9, endRow: 10, nextCellRow: null });
  });

  it("treats text before the first marker as one cell", () => {
    expect(findCell(["a = 1", "b = 2", "## x", "c"], 1)).toEqual({ startRow: 0, endRow: 1, nextCellRow: 2 });
    expect(findCell(["a = 1"], 0)).toEqual({ startRow: 0, endRow: 0, nextCellRow: null });
  });

  it("navigates between markers", () => {
    expect(nextCellMarkerRow(lines, 0)).toBe(4);
    expect(nextCellMarkerRow(lines, 4)).toBe(9);
    expect(nextCellMarkerRow(lines, 9)).toBeNull();
    expect(previousCellMarkerRow(lines, 9)).toBe(4);
    expect(previousCellMarkerRow(lines, 4)).toBe(0);
    expect(previousCellMarkerRow(lines, 0)).toBeNull();
  });
});

describe("findDefinition with real JETLS dumps", () => {
  const load = (name) => parseSymbolDump(fs.readFileSync(path.join(__dirname, "fixtures", "symbol-dumps", name), "utf8"));
  const structs = load("structs-and-methods.txt");
  const mod = load("module-and-consts.txt");
  // the dumps list the source line next to each symbol; rebuild a lineAt from them
  const lineAtFrom = (name) => {
    const rows = {};
    for (const line of fs.readFileSync(path.join(__dirname, "fixtures", "symbol-dumps", name), "utf8").split("\n")) {
      const m = /^\s*kind=\d+ .*? sel=(\d+):\d+-.*? \|\s?(.*)$/.exec(line);
      if (m && !(m[1] in rows)) rows[m[1]] = m[2];
    }
    return (r) => rows[r] || "";
  };

  it("returns the whole function when the cursor is anywhere inside it", () => {
    const def = findDefinition(structs, 70, lineAtFrom("structs-and-methods.txt")); // inside _index_lookup's loop
    expect(def).toEqual({ start: { row: 68, column: 0 }, end: { row: 75, column: 3 } });
  });

  it("moves the start back over a leading macro that JETLS leaves out of the range", () => {
    const lineAt = lineAtFrom("structs-and-methods.txt");
    expect(findDefinition(structs, 104, lineAt).start).toEqual({ row: 104, column: 0 }); // @inline data(...) = ...
    expect(findDefinition(structs, 140, lineAt)).toEqual({ start: { row: 138, column: 0 }, end: { row: 168, column: 3 } }); // @attributes mutable struct LadderStep
  });

  it("returns a struct as a whole, including its fields and inner constructors", () => {
    const def = findDefinition(structs, 150, lineAtFrom("structs-and-methods.txt"));
    expect(def.start.row).toBe(138);
    expect(def.end.row).toBe(168);
  });

  it("looks inside a module and returns its members rather than the module", () => {
    const lineAt = lineAtFrom("module-and-consts.txt");
    expect(findDefinition(mod, 219, lineAt)).toEqual({ start: { row: 219, column: 0 }, end: { row: 219, column: 51 } }); // const VERSION_NUMBER
    expect(findDefinition(mod, 227, lineAt).start.row).toBe(226); // function example
  });

  it("returns null between definitions, so the caller falls back to the line", () => {
    expect(findDefinition(structs, 17, () => "")).toBeNull();
    expect(findDefinition(mod, 20, () => "")).toBeNull(); // inside the module but not in a member
    expect(findDefinition(null, 3)).toBeNull();
  });
});
