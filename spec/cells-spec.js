// Cell separators, with a fake workspace and editor.
const { CellSeparators, CLASS } = require("../lib/cells");

function fakeEditor(text, grammar = "source.julia") {
  const listeners = { grammar: [], destroy: [], stop: [] };
  let lines = text.split("\n");
  const editor = {
    grammar,
    decorations: [],
    layers: [],
    setText(t) { lines = t.split("\n"); listeners.stop.forEach((fn) => fn()); },
    setGrammar(g) { editor.grammar = g; listeners.grammar.forEach((fn) => fn()); },
    destroy() { listeners.destroy.slice().forEach((fn) => fn()); },
    getGrammar: () => ({ scopeName: editor.grammar }),
    getBuffer: () => ({
      getLines: () => lines,
      onDidStopChanging: (fn) => { listeners.stop.push(fn); return { dispose: () => listeners.stop.splice(listeners.stop.indexOf(fn), 1) }; },
    }),
    onDidChangeGrammar: (fn) => { listeners.grammar.push(fn); return { dispose: () => {} }; },
    onDidDestroy: (fn) => { listeners.destroy.push(fn); return { dispose: () => listeners.destroy.splice(listeners.destroy.indexOf(fn), 1) }; },
    addMarkerLayer() {
      let markers = [];
      const layer = {
        destroyed: false,
        clear: () => { markers = []; },
        markBufferRange: (range) => { markers.push({ getBufferRange: () => ({ start: { row: range[0][0] } }) }); },
        getMarkers: () => markers,
        destroy: () => { layer.destroyed = true; },
      };
      editor.layers.push(layer);
      return layer;
    },
    decorateMarkerLayer: (layer, options) => editor.decorations.push(options),
    listeners,
  };
  return editor;
}

describe("cell separators", () => {
  let editors, cells, enabled;
  const workspace = {
    observeTextEditors: (fn) => { editors.forEach(fn); return { dispose: () => {} }; },
    getTextEditors: () => editors,
  };

  beforeEach(() => {
    enabled = true;
    editors = [fakeEditor("## setup\nx = 1\n\n# %% next\ny = 2\n#--- third\n#= not a marker =#"), fakeEditor("## markdown", "source.gfm")];
    cells = new CellSeparators({ workspace, isJulia: (e) => e.getGrammar().scopeName === "source.julia", enabled: () => enabled });
    cells.start();
  });
  afterEach(() => cells.dispose());

  it("marks the cell marker lines of Julia files, except the first line", () => {
    expect(editors[0].decorations).toEqual([{ type: "line", class: CLASS }]);
    expect(cells.rows(editors[0])).toEqual([3, 5]);
    expect(cells.rows(editors[1])).toEqual([]);
  });

  it("follows edits, grammar changes and the setting", () => {
    editors[0].setText("x = 1\n##\ny = 2");
    expect(cells.rows(editors[0])).toEqual([1]);
    editors[1].setGrammar("source.julia");
    expect(cells.rows(editors[1])).toEqual([]); // its marker is on the first line
    enabled = false;
    cells.refreshAll();
    expect(editors[0].layers[0].destroyed).toBe(true);
    expect(cells.rows(editors[0])).toEqual([]);
    enabled = true;
    cells.refreshAll();
    expect(cells.rows(editors[0])).toEqual([1]);
  });

  it("lets go of closed editors", () => {
    editors[0].destroy();
    expect(editors[0].layers[0].destroyed).toBe(true);
    expect(cells.tracked.size).toBe(0);
  });
});
