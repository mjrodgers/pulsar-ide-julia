const { signatureFromLine, decorateOutline, describeSymbols } = require("../lib/outline");

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
