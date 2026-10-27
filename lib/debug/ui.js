// The editor-facing half of debugging: panes, the current-line marker and breakpoint dots.
// Pulsar-only; DebugController talks to it through four methods (showLocation, openWorkspace, openOutput, bind).
const { WorkspacePane, URI: WORKSPACE_URI } = require("../workspace/pane");
const { OutputPane, URI: OUTPUT_URI } = require("./output-pane");
const { BreakpointGutters } = require("./gutters");

const CURRENT_LINE_CLASS = "pulsar-ide-julia-current-line";

class PulsarDebugUi {
  constructor({ workspace, document: doc = global.document }) {
    this.workspace = workspace;
    this.doc = doc;
    this.controller = null;
    this.disposables = [];
    this.marker = null;
    this.lastKey = null;
    this.revealToken = 0;
  }

  // Called once, after the controller exists.
  bind(controller) {
    this.controller = controller;
    this.disposables.push(
      this.workspace.addOpener((uri) => {
        if (uri === WORKSPACE_URI) return new WorkspacePane(controller.model, { document: this.doc });
        if (uri === OUTPUT_URI) return new OutputPane(controller.log, { document: this.doc });
        return undefined;
      }),
      new BreakpointGutters({ workspace: this.workspace, store: controller.store, document: this.doc })
    );
  }

  async openPane(uri, { focus = false } = {}) {
    const item = await this.workspace.open(uri, { searchAllPanes: true, activatePane: focus });
    const container = this.workspace.paneContainerForItem && this.workspace.paneContainerForItem(item);
    if (container && container.show) container.show();
    if (focus && item && item.focus) item.focus();
    return item;
  }

  openWorkspace(options) { return this.openPane(WORKSPACE_URI, options); }
  openOutput(options) { return this.openPane(OUTPUT_URI, options); }

  clearMarker() {
    if (this.marker) {
      try { this.marker.destroy(); } catch (e) { /* editor already gone */ }
      this.marker = null;
    }
  }

  // `location` is {file, line (1-based), frameId} or null.
  showLocation(location) {
    if (!location) {
      this.revealToken++;
      this.lastKey = null;
      this.clearMarker();
      return;
    }
    const key = `${location.file}:${location.line}:${location.frameId}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.reveal(location).catch((e) => console.warn("pulsar-ide-julia: could not show the current line", e));
  }

  async reveal({ file, line }) {
    const token = ++this.revealToken;
    const editor = await this.workspace.open(file, {
      initialLine: line - 1,
      initialColumn: 0,
      searchAllPanes: true,
      activatePane: false,
      pending: true,
      pane: this.workspace.getCenter().getActivePane(),
    });
    if (token !== this.revealToken || !editor || !editor.markBufferRange) return;
    this.clearMarker();
    const marker = editor.markBufferRange([[line - 1, 0], [line - 1, 0]], { invalidate: "never" });
    editor.decorateMarker(marker, { type: "line", class: CURRENT_LINE_CLASS });
    editor.decorateMarker(marker, { type: "line-number", class: CURRENT_LINE_CLASS });
    this.marker = marker;
    editor.scrollToBufferPosition([line - 1, 0], { center: true });
    editor.setCursorBufferPosition([line - 1, 0]);
  }

  destroy() {
    this.clearMarker();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}

module.exports = { PulsarDebugUi, CURRENT_LINE_CLASS };
