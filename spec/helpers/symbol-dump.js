// Parses the text written by the "Dump Document Symbols" command (lib/outline.js
// describeSymbols) back into DocumentSymbol objects, so specs can use real JETLS output.
const LINE = /^( *)kind=(\d+) name=("(?:[^"\\]|\\.)*")(?: detail=("(?:[^"\\]|\\.)*"))? sel=(\d+):(\d+)-(\d+):(\d+) range=(\d+):(\d+)-(\d+):(\d+)/;

function parseSymbolDump(text) {
  const roots = [];
  const stack = []; // stack[depth] = symbol
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const depth = m[1].length / 2;
    const rng = (a, b, c, d) => ({ start: { line: +a, character: +b }, end: { line: +c, character: +d } });
    const sym = {
      name: JSON.parse(m[3]),
      kind: +m[2],
      selectionRange: rng(m[5], m[6], m[7], m[8]),
      range: rng(m[9], m[10], m[11], m[12]),
      children: [],
    };
    if (m[4] !== undefined) sym.detail = JSON.parse(m[4]);
    stack.length = depth;
    stack[depth] = sym;
    (depth === 0 ? roots : stack[depth - 1].children).push(sym);
  }
  return roots;
}

module.exports = { parseSymbolDump };
