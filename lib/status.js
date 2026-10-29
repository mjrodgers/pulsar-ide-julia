// A status bar tile for the REPL started from Pulsar: the module the workspace shows, whether the REPL is running
// something, and how long the last code sent from Pulsar took. Shown only while the REPL's helper is connected;
// clicking it opens the Workspace pane (pulsar-ide-debugger).
const { createH } = require("./workspace/dom");
const { formatDuration } = require("./results");

// The module a REPL source shows (its contexts are the watches, if any, then the module).
const replModuleName = (state) => {
  const ctx = state && (state.contexts || []).find((c) => !c.watch);
  return (ctx && ctx.name) || "Main";
};

class ReplStatus {
  // bridge: ReplBridge (onDidConnect/onDidDisconnect); onClick(); document
  constructor({ bridge, onClick = () => {}, document = global.document }) {
    this.h = createH(document);
    this.source = null;
    this.tile = null;
    this.element = this.h("a", { class: "pulsar-ide-julia-status inline-block hidden", href: "#", onclick: (e) => { if (e && e.preventDefault) e.preventDefault(); onClick(); } });
    this.subscriptions = [
      bridge.onDidConnect((source) => this.follow(source)),
      bridge.onDidDisconnect(() => this.follow(null)),
    ];
    if (bridge.source) this.follow(bridge.source);
  }

  follow(source) {
    if (this.unfollow) this.unfollow();
    this.unfollow = null;
    this.source = source || null;
    if (source) {
      const update = () => this.render();
      source.on("state", update);
      this.unfollow = () => source.removeListener("state", update);
    }
    this.render();
  }

  render() {
    const h = this.h;
    const s = this.source && this.source.state;
    if (!s || s.status === "ended") {
      this.element.classList.add("hidden");
      return;
    }
    this.element.classList.remove("hidden");
    const name = replModuleName(s);
    const time = typeof s.lastMs === "number" ? formatDuration(s.lastMs) : "";
    this.element.classList.toggle("busy", !!s.busy);
    this.element.setAttribute("title", s.busy
      ? "The Julia REPL is running something. Click to open the Workspace pane."
      : `Julia REPL, showing ${name}${time ? `; the last code sent took ${time}` : ""}. Click to open the Workspace pane.`);
    h.replaceChildren(this.element, [
      s.busy ? h("span", { class: "loading loading-spinner-tiny inline-block" }) : h("span", { class: "icon icon-terminal" }),
      h("span", { class: "module" }, `Julia: ${name}`),
      s.busy ? h("span", { class: "detail" }, " running…") : time ? h("span", { class: "detail" }, ` · ${time}`) : null,
    ]);
  }

  // statusBar: the `status-bar` service.
  attach(statusBar) {
    if (this.tile) this.tile.destroy();
    this.tile = statusBar.addRightTile({ item: this.element, priority: 20 });
    return { dispose: () => { if (this.tile) this.tile.destroy(); this.tile = null; } };
  }

  dispose() {
    if (this.unfollow) this.unfollow();
    for (const s of this.subscriptions) s.dispose();
    if (this.tile) this.tile.destroy();
    this.tile = null;
  }
}

module.exports = { ReplStatus };
