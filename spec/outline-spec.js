const fs = require("fs");
const path = require("path");
const { parseSymbolDump } = require("./helpers/symbol-dump");
const { signatureFromLine, decorateOutline, describeSymbols, symbolsToOutline, symbolsToEntries, isDocumentSymbolReply } = require("../lib/outline");

describe("signatureFromLine", () => {
  const sig = (line, name, options) => signatureFromLine(line, name, options);

  it("handles long-form definitions", () => {
    expect(sig("function foo(x::Int, y)", "foo")).toBe("foo(x::Int, y)");
    expect(sig("function foo(x::T) where {T<:Number}", "foo")).toBe("foo(x::T) where {T<:Number}");
    expect(sig("function foo(x; k = 1)", "foo")).toBe("foo(x; k = 1)");
  });

  it("handles short-form definitions, cutting at the defining =", () => {
    expect(sig("foo(x::Int) = x + 1", "foo")).toBe("foo(x::Int)");
    expect(sig("foo(x::T) where T = x", "foo")).toBe("foo(x::T) where T");
    expect(sig("foo(x)::Int = 1", "foo")).toBe("foo(x)::Int");
    expect(sig('foo(x = "a#b=c") = 1', "foo")).toBe('foo(x = "a#b=c")');
  });

  it("keeps qualified names and strips leading macros", () => {
    expect(sig("Base.show(io::IO, x::Foo) = print(io, x)", "show")).toBe("Base.show(io::IO, x::Foo)");
    expect(sig("@inline function foo(x)", "foo")).toBe("foo(x)");
    expect(sig("Base.@propagate_inbounds foo(x) = x", "foo")).toBe("foo(x)");
  });

  it("handles callable objects and macros", () => {
    expect(sig("function (f::Foo)(x)", "Foo")).toBe("(f::Foo)(x)");
    expect(sig("macro foo(x)", "@foo")).toBe("@foo(x)");
  });

  it("drops one-line `end`s, trailing statements and comments", () => {
    expect(sig("function foo(x) end", "foo")).toBe("foo(x)");
    expect(sig("function foo(x); x; end", "foo")).toBe("foo(x)");
    expect(sig("function foo(x) # does things", "foo")).toBe("foo(x)");
  });

  it("marks signatures whose arguments continue on the next line", () => {
    expect(sig("function foo(x,", "foo")).toBe("foo(x, …");
  });

  it("returns null for lines that are not a definition of that name", () => {
    expect(sig("struct Foo", "Foo")).toBeNull();
    expect(sig("const x = f(1)", "x")).toBeNull();
    expect(sig("x = foo(1)", "x")).toBeNull();
    expect(sig("bar(x) = 1", "foo")).toBeNull();
    expect(sig("", "foo")).toBeNull();
  });

  it("truncates very long signatures", () => {
    const out = sig(`function foo(${"a, ".repeat(100)}z)`, "foo", { maxLength: 30 });
    expect(out.length).toBe(30);
    expect(out.slice(-1)).toBe("…");
  });
});

describe("decorateOutline", () => {
  const source = [
    "function foo(x::Int)",
    "    x",
    "end",
    "foo(x::String) = x",
    "struct Point",
    "  x::Int",
    "end",
  ];
  const lineAt = (row) => source[row];
  const tree = (name, row, children = []) => ({ plainText: name, representativeName: name, startPosition: { row, column: 0 }, children });

  it("replaces names with signatures, tokenizes them, and leaves other symbols alone", () => {
    const outline = { outlineTrees: [tree("foo", 0), tree("foo", 3), tree("Point", 4)] };
    const out = decorateOutline(outline, lineAt);

    expect(out.outlineTrees[0].plainText).toBe("foo(x::Int)");
    expect(out.outlineTrees[1].plainText).toBe("foo(x::String)");
    expect(out.outlineTrees[2].plainText).toBe("Point");
    expect(out.outlineTrees[0].tokenizedText).toEqual([
      { kind: "method", value: "foo" },
      { kind: "plain", value: "(x::Int)" },
    ]);
  });

  it("recurses into children and does not mutate its input", () => {
    const outline = { outlineTrees: [tree("Mod", 4, [tree("foo", 3)])] };
    const out = decorateOutline(outline, lineAt);
    expect(out.outlineTrees[0].children[0].plainText).toBe("foo(x::String)");
    expect(outline.outlineTrees[0].children[0].plainText).toBe("foo");
  });

  it("copes with trees that only have tokenizedText and a Point-like or array start", () => {
    const only = { tokenizedText: [{ kind: "method", value: "foo" }], startPosition: [0, 0], children: [] };
    const out = decorateOutline({ outlineTrees: [only] }, lineAt);
    expect(out.outlineTrees[0].plainText).toBe("foo(x::Int)");
  });

  it("handles exactly what the fork's OutlineViewAdapter produces for a DocumentSymbol", () => {
    // Point-like startPosition (the symbol's selectionRange.start), tokenizedText only, an icon.
    const point = (row, column) => ({ row, column, isLessThanOrEqual() { return true; } });
    const adapterTree = {
      tokenizedText: [{ kind: "constructor", value: "foo" }],
      icon: "type-function",
      representativeName: "foo",
      startPosition: point(0, 9),
      endPosition: point(0, 12),
      children: [],
    };
    const out = decorateOutline({ outlineTrees: [adapterTree] }, lineAt).outlineTrees[0];
    expect(out.plainText).toBe("foo(x::Int)");
    expect(out.icon).toBe("type-function");
    expect(out.endPosition).toBe(adapterTree.endPosition);
    expect(out.tokenizedText[0]).toEqual({ kind: "constructor", value: "foo" });
  });

  it("passes through a missing or empty outline", () => {
    expect(decorateOutline(null, lineAt)).toBeNull();
    expect(decorateOutline({}, lineAt)).toEqual({});
  });
});

describe("decorateOutline repeats", () => {
  const source = ["function foo(x::Int)", "  x", "end", "function foo(x::Int)", "  x", "end", "foo(x::String) = x"];
  const lineAt = (row) => source[row];
  const tree = (row, children = []) => ({ representativeName: "foo", tokenizedText: [{ kind: "method", value: "foo" }], startPosition: { row, column: 9 }, children });
  const texts = (trees) => trees.map((t) => t.plainText);

  it("drops leaf children that point at their parent's own line", () => {
    const out = decorateOutline({ outlineTrees: [tree(0, [tree(0), tree(0)])] }, lineAt);
    expect(texts(out.outlineTrees)).toEqual(["foo(x::Int)"]);
    expect(out.outlineTrees[0].children.length).toBe(0);
  });

  it("drops siblings that repeat the same line, but keeps different lines even with equal labels", () => {
    const out = decorateOutline({ outlineTrees: [tree(0), tree(0), tree(3), tree(6)] }, lineAt);
    expect(texts(out.outlineTrees)).toEqual(["foo(x::Int)", "foo(x::Int)", "foo(x::String)"]);
  });

  it("keeps children that have their own children", () => {
    const out = decorateOutline({ outlineTrees: [tree(0, [tree(0, [tree(1)])])] }, lineAt);
    expect(out.outlineTrees[0].children.length).toBe(1);
  });
});

describe("describeSymbols", () => {
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

  it("lists a hierarchy with kinds, ranges and the source line", () => {
    const out = describeSymbols(
      [{ name: "foo", kind: 12, detail: "d", range: r(0, 0, 2, 3), selectionRange: r(0, 9, 0, 12),
         children: [{ name: "x", kind: 13, range: r(1, 2, 1, 3), selectionRange: r(1, 2, 1, 3) }] }],
      (row) => ["function foo(x)", "  x"][row]
    );
    const lines = out.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('kind=12 name="foo" detail="d" sel=0:9-0:12 range=0:0-2:3');
    expect(lines[0]).toContain("| function foo(x)");
    expect(lines[1].startsWith("  kind=13")).toBe(true);
  });

  it("handles SymbolInformation and empty input", () => {
    const out = describeSymbols([{ name: "foo", kind: 12, containerName: "M", location: { range: r(3, 0, 4, 0) } }]);
    expect(out).toContain('container="M" sel=3:0-4:0');
    expect(describeSymbols(null)).toBe("");
  });
});

describe("symbolsToOutline (JETLS DocumentSymbol shape)", () => {
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  const sym = (name, kind, detail, sel, extra = {}) => ({ name, kind, detail, range: extra.range || sel, selectionRange: sel, children: extra.children });
  const labels = (trees) => trees.map((t) => [t.plainText, ...labels(t.children)]).flat();

  // modelled on a real dump: arguments, locals, `for` blocks (kind 3, blank name) under a function
  const reparent = sym("reparent", 12, "function reparent(G::PermGroup, x::PermGroupElem)", r(13, 17, 13, 25), { range: r(13, 8, 15, 3), children: [
    sym("G", 19, "::PermGroup", r(13, 26, 13, 27)),
    sym("x", 19, "::PermGroupElem", r(13, 40, 13, 41)),
  ] });
  const game = sym("ladder_game!", 12, "function ladder_game!(L::SubgroupLadder, G::PermGroup)", r(18, 9, 18, 21), { range: r(18, 0, 35, 3), children: [
    sym("sprev", 13, "= L[1]", r(19, 4, 19, 9)),
    sym("L", 19, "::SubgroupLadder", r(18, 22, 18, 23)),
    sym(" ", 3, "for s in L", r(20, 7, 20, 14), { range: r(20, 4, 24, 7), children: [sym("s", 13, "for s in L", r(20, 8, 20, 9))] }),
  ] });
  const method2 = sym("_my_intersect", 12, "function _my_intersect(V::AbstractVector{PermGroup})", r(311, 9, 311, 22), { range: r(311, 0, 315, 3) });
  const method1 = sym("_my_intersect", 12, "function _my_intersect(G1::PermGroup, G2::PermGroup)", r(317, 9, 317, 22), { range: r(317, 0, 321, 3) });
  const constant = sym("N", 14, "const N = 3", r(2, 6, 2, 7));

  it("recognizes the reply shape", () => {
    expect(isDocumentSymbolReply([reparent])).toBe(true);
    expect(isDocumentSymbolReply([])).toBe(false);
    expect(isDocumentSymbolReply(null)).toBe(false);
    expect(isDocumentSymbolReply([{ name: "x", location: {} }])).toBe(false);
  });

  it("labels functions with their signature, in source order, and keeps repeated names distinct", () => {
    const out = symbolsToOutline([method1, constant, reparent, method2]);
    expect(labels(out.outlineTrees)).toEqual([
      "N", "reparent(G::PermGroup, x::PermGroupElem)",
      "_my_intersect(V::AbstractVector{PermGroup})", "_my_intersect(G1::PermGroup, G2::PermGroup)",
    ]);
  });

  it("hides arguments, locals and loop blocks by default", () => {
    const out = symbolsToOutline([reparent, game]);
    expect(labels(out.outlineTrees)).toEqual(["reparent(G::PermGroup, x::PermGroupElem)", "ladder_game!(L::SubgroupLadder, G::PermGroup)"]);
  });

  it("shows them when asked, in source order, naming blank blocks by their detail", () => {
    const out = symbolsToOutline([game], { showLocals: true });
    expect(labels(out.outlineTrees)).toEqual(["ladder_game!(L::SubgroupLadder, G::PermGroup)", "L", "sprev", "for s in L", "s"]);
  });

  it("still lists a function defined inside a loop block", () => {
    const inner = sym("helper", 12, "function helper(y)", r(22, 12, 22, 18));
    const outer = sym("outer", 12, "function outer()", r(0, 9, 0, 14), { range: r(0, 0, 30, 3), children: [
      sym(" ", 3, "for i in 1:3", r(20, 7, 20, 14), { children: [sym("i", 13, "for i in 1:3", r(20, 8, 20, 9)), inner] }),
    ] });
    expect(labels(symbolsToOutline([outer]).outlineTrees)).toEqual(["outer()", "helper(y)"]);
  });

  it("uses plain names when signatures are off, and names when a function has no detail", () => {
    expect(labels(symbolsToOutline([reparent], { signatures: false }).outlineTrees)).toEqual(["reparent"]);
    expect(labels(symbolsToOutline([sym("f", 12, undefined, r(0, 0, 0, 1))]).outlineTrees)).toEqual(["f"]);
  });

  it("copes with short-form and macro details, and truncates long ones", () => {
    expect(labels(symbolsToOutline([sym("foo", 12, "foo(x::Int) = x + 1", r(0, 0, 0, 3))]).outlineTrees)).toEqual(["foo(x::Int)"]);
    expect(labels(symbolsToOutline([sym("@m", 12, "macro m(x)", r(0, 0, 0, 2))]).outlineTrees)).toEqual(["@m(x)"]);
    const long = sym("foo", 12, `function foo(${"a, ".repeat(100)}z)`, r(0, 0, 0, 3));
    expect(symbolsToOutline([long], { maxLength: 30 }).outlineTrees[0].plainText.length).toBe(30);
  });

  it("produces what Pulsar's outline view reads", () => {
    const [tree] = symbolsToOutline([reparent]).outlineTrees;
    expect(tree.icon).toBe("type-function");
    expect(tree.representativeName).toBe("reparent");
    expect(tree.tokenizedText[0]).toEqual({ kind: "method", value: "reparent" });
    expect(tree.startPosition.row).toBe(13);
    expect(tree.startPosition.column).toBe(17);
    expect(tree.endPosition.column).toBe(25);
  });

  it("returns an empty outline for no symbols", () => {
    expect(symbolsToOutline(null)).toEqual({ outlineTrees: [] });
    expect(symbolsToOutline([])).toEqual({ outlineTrees: [] });
  });
});

// Real JETLS output, captured with the "Dump Document Symbols" command.
describe("symbolsToOutline with real JETLS dumps", () => {
  const load = (name) => parseSymbolDump(fs.readFileSync(path.join(__dirname, "fixtures", "symbol-dumps", name), "utf8"));
  const flat = (trees) => trees.map((t) => [t.plainText, ...flat(t.children)]).flat();
  const tops = (trees) => trees.map((t) => t.plainText);

  describe("a file of structs and methods", () => {
    const symbols = load("structs-and-methods.txt");

    it("parses the whole dump", () => {
      expect(symbols.length).toBeGreaterThan(40);
      expect(symbols[1].children.length).toBe(5); // GAPTransversalTest's fields
    });

    it("labels every top-level entry: types by header, functions by signature", () => {
      const labels = tops(symbolsToOutline(symbols).outlineTrees);
      expect(labels.slice(0, 8)).toEqual([
        "AbstractTestFunction",
        "GAPTransversalTest <: AbstractTestFunction",
        "GAPTransversalTest(G::PermGroup, H::PermGroup; ambient::PermGroup = G)",
        "_coset_rep(tf::GAPTransversalTest, x::PermGroupElem)",
        "FunctionTest{F} <: AbstractTestFunction",
        "FunctionTest(Tvec::Vector{PermGroupElem}, f::F; ambient::PermGroup = parent(first(Tvec))) where F",
        "_coset_rep(tf::FunctionTest, x::PermGroupElem)",
        "coset_rep(tf::AbstractTestFunction, x::PermGroupElem)",
      ]);
    });

    it("handles short-form methods of qualified names, with or without a leading macro", () => {
      const labels = tops(symbolsToOutline(symbols).outlineTrees);
      expect(labels).toContain("Oscar.elements(tf::AbstractTestFunction)");
      expect(labels).toContain("data(T::TransversalChain)");
      expect(labels).toContain("Base.getindex(T::TransversalChain, i::IntegerUnion)");
      expect(labels).toContain('Base.show(io::IO, ::MIME"text/plain", S::LadderStep)');
    });

    it("keeps repeated names as separate entries, each with its own signature", () => {
      const shows = tops(symbolsToOutline(symbols).outlineTrees).filter((l) => l.startsWith("Base.show("));
      expect(shows.length).toBe(7);
      expect(new Set(shows).size).toBe(7);
    });

    it("shows struct fields with their types, and inner constructors with signatures", () => {
      const ladder = symbolsToOutline(symbols).outlineTrees.find((t) => t.plainText === "LadderStep");
      expect(ladder.tokenizedText[0].kind).toBe("type");
      expect(flat(ladder.children)).toEqual([
        "is_up_step::Bool", "Aprev::PermGroup", "A::PermGroup", "test::AbstractTestFunction",
        "DSt::Dict{PermGroupElem, TransversalChain}", "Im::Dict{PermGroupElem, Tuple{PermGroupElem, PermGroupElem}}", "F",
        "LadderStep(Aprev::PermGroup, A::PermGroup)",
        "LadderStep(Aprev::PermGroup, A::PermGroup, test::AbstractTestFunction)",
      ]);
    });

    it("contains no arguments, locals or blocks unless asked for", () => {
      const all = flat(symbolsToOutline(symbols).outlineTrees);
      for (const unwanted of ["tf", "x", "idx", "for (i, a) in enumerate(elements(tf))"]) expect(all).not.toContain(unwanted);
      const withLocals = flat(symbolsToOutline(symbols, { showLocals: true }).outlineTrees);
      expect(withLocals).toContain("for (i, a) in enumerate(elements(tf))");
      expect(withLocals).toContain("idx");
    });

    it("never produces an empty label, and keeps labels to one line", () => {
      for (const showLocals of [false, true]) {
        for (const label of flat(symbolsToOutline(symbols, { showLocals }).outlineTrees)) {
          expect(label.trim().length).toBeGreaterThan(0);
          expect(label.includes("\n")).toBe(false);
        }
      }
    });
  });

  describe("a module with constants and a macro", () => {
    const symbols = load("module-and-consts.txt");

    it("lists the module's contents: constants by name, functions and macros by signature", () => {
      const [mod] = symbolsToOutline(symbols).outlineTrees;
      expect(mod.plainText).toBe("Oscar");
      expect(tops(mod.children)).toEqual([
        "windows_error()", "_print_banner(;is_dev = Oscar.is_dev)", "__init__()",
        "VERSION_NUMBER", "PROJECT_UUID", "is_dev", "oscardir",
        "example(s::String)", "@example(s)", "data(s::String)", "revise(s::String)", "system(s::String)", "build()", "ANTIC",
      ]);
    });

    it("collapses a multi-line block label when locals are shown", () => {
      const init = symbolsToOutline(symbols, { showLocals: true }).outlineTrees[0].children.find((t) => t.plainText === "__init__()");
      expect(init.children[0].plainText).toBe("for pkg in [ …");
      expect(init.children[0].children[0].plainText).toBe("pkg");
    });
  });
});

describe("symbolsToEntries (Go to Symbol)", () => {
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  const sym = (name, kind, detail, sel, extra = {}) => ({ name, kind, detail, range: extra.range || sel, selectionRange: sel, children: extra.children });
  const brief = (entries) => entries.map((e) => [e.name, e.context ?? null, e.tag ?? null]);

  const method1 = sym("orbit", 12, "function orbit(G::PermGroup, omega)", r(10, 9, 10, 14), { range: r(10, 0, 12, 3), children: [
    sym("G", 19, "::PermGroup", r(10, 15, 10, 16)),
    sym(" ", 3, "for g in G", r(11, 4, 11, 14), { children: [sym("g", 13, "for g in G", r(11, 8, 11, 9))] }),
  ] });
  const method2 = sym("orbit", 12, "(G::GAPGroup, Omega::GSet) =", r(20, 0, 20, 5));
  const type = sym("Ladder", 23, "struct Ladder{T} <: AbstractVector{T}", r(2, 7, 2, 13), { range: r(2, 0, 5, 3), children: [
    sym("groups", 8, "::Vector{T}", r(3, 4, 3, 10)),
  ] });

  it("names each entry and puts the argument list in its context, so methods can be told apart", () => {
    expect(brief(symbolsToEntries([method2, type, method1]))).toEqual([
      ["Ladder", "{T} <: AbstractVector{T}", "struct"],
      ["groups", "::Vector{T}", "field"],
      ["orbit", "(G::PermGroup, omega)", "function"],
      ["orbit", "(G::GAPGroup, Omega::GSet)", "function"],
    ]);
  });

  it("leaves out arguments, locals and blocks unless asked, and never lists a blank block itself", () => {
    expect(brief(symbolsToEntries([method1], { showLocals: true }))).toEqual([
      ["orbit", "(G::PermGroup, omega)", "function"],
      ["G", null, null],
      ["g", null, "variable"],
    ]);
  });

  it("gives bare names when signatures are off", () => {
    expect(brief(symbolsToEntries([method1], { signatures: false }))).toEqual([["orbit", null, "function"]]);
  });

  it("places each entry at its name", () => {
    class P { constructor(row, column) { this.row = row; this.column = column; } }
    class R { constructor(start, end) { this.start = start; this.end = end; } }
    const [entry] = symbolsToEntries([method1], { Point: P, Range: R });
    expect(entry.position).toEqual(new P(10, 9));
    expect(entry.range).toEqual(new R(new P(10, 9), new P(10, 14)));
  });
});
