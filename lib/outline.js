// Show method signatures in the outline view.
//
// Julia code defines the same function name many times, so an outline of bare names is
// not much use. The language server's symbol only carries the name, so read the
// definition line from the buffer and show that as the label instead:
//
//   function foo(x::Int, y)           ->  foo(x::Int, y)
//   foo(x::T) where T = x + 1         ->  foo(x::T) where T
//   @inline function bar(a; k = 1)    ->  bar(a; k = 1)
//   Base.show(io::IO, x::Foo) = ...   ->  Base.show(io::IO, x::Foo)

const MACRO_PREFIX = /^[\w.]*@[\w!]+\s+/; // @inline, Base.@propagate_inbounds, @generated
const LOOKS_LIKE_CALL = /^(?:\(.*?\)|[\p{L}_][\p{L}\p{N}_!.]*(?:\{.*?\})?)\s*\(/u;

function stripMacros(s) {
  let previous;
  do { previous = s; s = s.replace(MACRO_PREFIX, ""); } while (s !== previous);
  return s;
}

// Index of the first top-level (not nested, not in a string or comment) position where
// `stop(s, i)` holds, plus the nesting depth reached (>0 means unbalanced).
function scan(s, stop) {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "#") return { index: i, depth };
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && stop(s, i)) return { index: i, depth };
  }
  return { index: s.length, depth };
}

const isStatementEnd = (s, i) => s[i] === ";";
const isDefinitionEquals = (s, i) =>
  s[i] === "=" && s[i + 1] !== "=" && s[i + 1] !== ">" && !"=!<>.".includes(s[i - 1] || "");

// The signature on a definition line, or null if the line is not one for `name`.
function signatureFromLine(line, name = "", { maxLength = 120 } = {}) {
  let s = stripMacros(String(line).trim());
  let longForm = false;

  if (/^function\s/.test(s)) {
    s = s.replace(/^function\s+/, "");
    longForm = true;
  } else if (/^macro\s/.test(s)) {
    s = "@" + s.replace(/^macro\s+/, "");
    longForm = true;
  } else if (!LOOKS_LIKE_CALL.test(s)) {
    return null;
  }

  const { index, depth } = scan(s, longForm ? isStatementEnd : isDefinitionEquals);
  let signature = s.slice(0, index).trim();
  if (longForm) signature = signature.replace(/\s+end$/, "");
  if (!signature) return null;
  if (depth > 0) signature += " …"; // arguments continue on the next line

  const base = String(name).split(".").pop();
  if (base && !signature.includes(base)) return null; // not the definition this symbol points at

  return signature.length > maxLength ? `${signature.slice(0, maxLength - 1)}…` : signature;
}

function tokenize(signature, name, kind = "method") {
  const full = String(name || "");
  if (full && signature.startsWith(full)) {
    const rest = signature.slice(full.length);
    return rest ? [{ kind, value: full }, { kind: "plain", value: rest }] : [{ kind, value: full }];
  }
  const base = String(name).split(".").pop();
  const at = base ? signature.indexOf(base) : -1;
  if (at < 0) return [{ kind: "plain", value: signature }];
  const tokens = [];
  if (at > 0) tokens.push({ kind: "plain", value: signature.slice(0, at) });
  tokens.push({ kind, value: base });
  const rest = signature.slice(at + base.length);
  if (rest) tokens.push({ kind: "plain", value: rest });
  return tokens;
}

// The adapter's tree shape has varied (Point vs plain object, plainText vs tokenizedText
// only), so read positions and names defensively.
function rowOf(tree) {
  const start = tree.startPosition || (tree.range && tree.range.start);
  if (Array.isArray(start)) return start[0];
  if (start && typeof start.row === "number") return start.row;
  if (start && typeof start.line === "number") return start.line;
  return undefined;
}

// Keep the kind the adapter chose for the name (method, constructor, type, ...).
function firstKind(tree) {
  const first = Array.isArray(tree.tokenizedText) && tree.tokenizedText[0];
  return (first && first.kind) || "method";
}

function nameOf(tree) {
  if (tree.representativeName) return tree.representativeName;
  if (tree.plainText) return tree.plainText;
  if (Array.isArray(tree.tokenizedText)) return tree.tokenizedText.map((t) => t.value).join("");
  return tree.name || "";
}

// `outline` is an Atom IDE Outline ({ outlineTrees: [{ plainText, tokenizedText,
// representativeName, startPosition: { row }, children }] }). Returns a decorated copy.
function decorateOutline(outline, lineAt, options = {}) {
  if (!outline || !Array.isArray(outline.outlineTrees)) return outline;

  const visit = (tree) => {
    const children = (tree.children || []).map(visit);
    const row = rowOf(tree);
    const name = nameOf(tree);
    const line = typeof row === "number" ? lineAt(row) : null;
    const signature = typeof line === "string" ? signatureFromLine(line, name, options) : null;
    if (!signature) return { ...tree, children };
    return { ...tree, plainText: signature, tokenizedText: tokenize(signature, name, firstKind(tree)), children };
  };

  return { ...outline, outlineTrees: dedupe(outline.outlineTrees.map(visit), undefined) };
}

// A server may list the same definition more than once: as children that point at the same
// line as their parent, or as siblings sharing a line. Once every label is a signature those
// show up as exact repeats, so keep one of each (same row *and* same label).
function dedupe(trees, parentRow) {
  const seen = new Set();
  const out = [];
  for (const tree of trees) {
    const row = rowOf(tree);
    const key = `${row}\u0000${tree.plainText || nameOf(tree)}`;
    const leaf = !tree.children || tree.children.length === 0;
    const repeatsParent = leaf && typeof row === "number" && row === parentRow && tree.plainText;
    if (seen.has(key) || repeatsParent) continue;
    seen.add(key);
    out.push({ ...tree, children: dedupe(tree.children || [], row) });
  }
  return out;
}

// Plain-text dump of a raw documentSymbol response (DocumentSymbol[] or SymbolInformation[]),
// for working out what a server really reports. `lineAt(row)` supplies the source line.
function describeSymbols(symbols, lineAt = () => "") {
  const lines = [];
  const pos = (p) => (p ? `${p.line}:${p.character}` : "?");
  const span = (r) => (r ? `${pos(r.start)}-${pos(r.end)}` : "?");
  const walk = (list, depth) => {
    for (const sym of list || []) {
      const sel = sym.selectionRange || (sym.location && sym.location.range);
      const row = sel && sel.start ? sel.start.line : undefined;
      const text = typeof row === "number" ? String(lineAt(row) || "").trim().slice(0, 100) : "";
      lines.push(
        `${"  ".repeat(depth)}kind=${sym.kind} name=${JSON.stringify(sym.name)}` +
          (sym.detail ? ` detail=${JSON.stringify(sym.detail)}` : "") +
          (sym.containerName ? ` container=${JSON.stringify(sym.containerName)}` : "") +
          ` sel=${span(sel)}` +
          (sym.range ? ` range=${span(sym.range)}` : "") +
          (text ? `  | ${text}` : "")
      );
      walk(sym.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return lines.join("\n");
}


// ---------------------------------------------------------------------------------------
// Building the outline from the server's raw `textDocument/documentSymbol` reply.
//
// JETLS reports one DocumentSymbol per function (kind 12) whose `detail` is the full
// signature ("function foo(x::Int; k = 1) where T"), with the arguments (kind 19), local
// variables (13), type parameters (26) and loop/let blocks (kind 3, blank name) as its
// children. The fork's OutlineViewAdapter keeps only `name`, so we convert the reply
// ourselves: label functions with their signature, and (by default) leave out the noise.

const SymbolKind = { Class: 5, Interface: 11, Field: 8, Method: 6, Function: 12, Variable: 13, Namespace: 3, Constructor: 9, String: 15, Object: 19, Struct: 23, TypeParameter: 26 };

const ICONS = {
  1: "type-file", 2: "type-module", 3: "type-namespace", 4: "type-package", 5: "type-class", 6: "type-method",
  7: "type-property", 8: "type-field", 9: "type-constructor", 10: "type-enum", 11: "type-interface",
  12: "type-function", 13: "type-variable", 14: "type-constant", 15: "type-string", 16: "type-number",
  17: "type-boolean", 18: "type-array", 22: "type-constant", 23: "type-class",
};

function tokenKind(kind) {
  switch (kind) {
    case SymbolKind.Class: case SymbolKind.Struct: case SymbolKind.Interface: return "type";
    case SymbolKind.Constructor: return "constructor";
    case SymbolKind.Method: case SymbolKind.Function: return "method";
    case SymbolKind.String: return "string";
    default: return "plain";
  }
}

const isFunction = (sym) => sym.kind === SymbolKind.Function || sym.kind === SymbolKind.Method;
const isBlankBlock = (sym) => sym.kind === SymbolKind.Namespace && !String(sym.name || "").trim();

// Inside a function: drop arguments, locals and type parameters; look through blank-named
// blocks (for/while/let ...) so a function defined inside one is still listed.
function withoutLocals(children) {
  const out = [];
  for (const child of children || []) {
    if (child.kind === SymbolKind.Variable || child.kind === SymbolKind.Object || child.kind === SymbolKind.TypeParameter) continue;
    if (isBlankBlock(child)) { out.push(...withoutLocals(child.children)); continue; }
    out.push({ ...child, children: child.children });
  }
  return out;
}

const compareSymbols = (a, b) =>
  a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character ||
  a.range.end.line - b.range.end.line || a.range.end.character - b.range.end.character;

class PlainPoint { constructor(row, column) { this.row = row; this.column = column; } }

// True when `symbols` is a hierarchical DocumentSymbol[] reply.
function isDocumentSymbolReply(symbols) {
  return Array.isArray(symbols) && symbols.length > 0 && symbols[0].selectionRange !== undefined;
}

const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const TYPE_PREFIX = /^(?:mutable\s+)?struct\s+|^abstract\s+type\s+|^primitive\s+type\s+/;

// What to show for one symbol. JETLS `detail` by kind:
//   function/method  "function f(x::Int) where T"      or, for `f(x) = ...`, just "(x::Int) ="
//   struct/abstract  "mutable struct Foo{T} <: Bar"     (macros like @kwdef are not included)
//   field            "::Vector{Int}"
//   blank block      "for x in xs" (may span many lines)
function labelFor(sym, { signatures, maxLength }) {
  const name = String(sym.name || "");
  const detail = sym.detail == null ? "" : String(sym.detail);

  if (!name.trim()) { // a blank-named `for`/`while`/`let` block: use its first line
    const lines = detail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return truncate(lines.length > 1 ? `${lines[0]} …` : lines[0] || name, maxLength);
  }
  if (!signatures || !detail) return name;

  if (isFunction(sym)) {
    const text = oneLine(detail);
    if (text.startsWith("(") && text.endsWith("=")) { // short form: the name is not part of the detail
      return truncate(`${name}${text.slice(0, -1).trimEnd()}`, maxLength);
    }
    return signatureFromLine(text, name, { maxLength }) || name;
  }
  if (sym.kind === SymbolKind.Struct || sym.kind === SymbolKind.Interface || sym.kind === SymbolKind.Class) {
    const header = oneLine(detail).replace(TYPE_PREFIX, "").replace(/\s+end$/, "");
    return header.startsWith(name) ? truncate(header, maxLength) : name;
  }
  if (sym.kind === SymbolKind.Field && detail.startsWith("::")) {
    return truncate(`${name}${oneLine(detail)}`, maxLength);
  }
  return name;
}

// -> Atom IDE Outline. Options: { Point (constructor taking row, column), showLocals, signatures, maxLength }.
function symbolsToOutline(symbols, { Point = PlainPoint, showLocals = false, signatures = true, maxLength = 120 } = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return { outlineTrees: [] };

  const convert = (list, hideLocals) =>
    [...list].sort(compareSymbols).map((sym) => {
      const label = labelFor(sym, { signatures, maxLength });
      const kids = hideLocals && isFunction(sym) ? withoutLocals(sym.children) : sym.children || [];
      const sel = sym.selectionRange;
      return {
        plainText: label,
        tokenizedText: tokenize(label, sym.name, tokenKind(sym.kind)),
        icon: ICONS[sym.kind],
        representativeName: sym.name,
        startPosition: new Point(sel.start.line, sel.start.character),
        endPosition: new Point(sel.end.line, sel.end.character),
        children: convert(kids, hideLocals),
      };
    });

  return { outlineTrees: convert(symbols, !showLocals) };
}

module.exports = { signatureFromLine, decorateOutline, describeSymbols, symbolsToOutline, isDocumentSymbolReply };
