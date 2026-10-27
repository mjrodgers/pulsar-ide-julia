const { signatureFromLine, decorateOutline } = require("../lib/outline");

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
