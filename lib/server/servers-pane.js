// The "Julia Language Servers" pane: one row per project root with its JETLS server's state, process, memory and
// open Julia files, and buttons to restart, stop or start it. Plain DOM; refreshes itself while open.
const { createH } = require("../workspace/dom");
const { sampleMemory: defaultSample, formatBytes } = require("./memory");
// Node's own timers: Pulsar's spec runner replaces the window's with a mock clock.
const { setInterval, clearInterval } = require("timers");

const URI = "atom://pulsar-ide-julia/language-servers";

class ServersPane {
  // registry: a ServerRegistry. options: sampleMemory(pids), notify(kind, message), restartAll(), interval (ms; 0 = no timer)
  constructor(registry, { document: doc = global.document, sampleMemory = defaultSample, notify = () => {}, restartAll = null, interval = 5000 } = {}) {
    this.registry = registry;
    this.sampleMemory = sampleMemory;
    this.notify = notify;
    this.restartAll = restartAll;
    this.h = createH(doc);
    this.destroyed = false;
    this.destroyListeners = [];
    this.busy = new Set(); // roots with an action in progress
    this.memory = new Map(); // pid -> bytes | null
    this.refreshing = null;

    const h = this.h;
    this.summary = h("div", { class: "summary" });
    this.body = h("div", { class: "servers" });
    this.element = h("div", { class: "pulsar-ide-julia-servers", tabindex: "-1" },
      h("div", { class: "toolbar" },
        this.summary,
        h("button", { class: "btn btn-sm icon icon-sync refresh", title: "Read the processes again", onclick: () => this.refresh() }, "Refresh"),
        this.restartAll ? h("button", { class: "btn btn-sm restart-all", title: "Restart every JETLS server", onclick: () => this.runAll() }, "Restart all") : null),
      this.body);

    this.render();
    this.refresh();
    this.timer = interval > 0 ? setInterval(() => this.refresh(), interval) : null;
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // --- pane item interface ---------------------------------------------------------------------
  getTitle() { return "Julia Language Servers"; }
  getURI() { return URI; }
  getIconName() { return "server"; }
  getDefaultLocation() { return "bottom"; }
  getAllowedLocations() { return ["bottom", "left", "right", "center"]; }
  getElement() { return this.element; }
  onDidDestroy(fn) { this.destroyListeners.push(fn); return { dispose: () => { this.destroyListeners = this.destroyListeners.filter((f) => f !== fn); } }; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.destroyListeners.forEach((fn) => fn());
  }

  // --- data ------------------------------------------------------------------------------------
  rows() {
    return this.registry.available ? this.registry.list() : [];
  }

  // Reads the servers and their memory, then redraws. Overlapping calls share one refresh.
  refresh() {
    if (this.destroyed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const pids = this.rows().map((r) => r.pid).filter((p) => p != null);
        this.memory = await this.sampleMemory(pids);
      } catch (e) {
        this.memory = new Map();
      } finally {
        this.refreshing = null;
      }
      if (!this.destroyed) this.render();
    })();
    return this.refreshing;
  }

  async run(root, action) {
    if (this.busy.has(root)) return;
    this.busy.add(root);
    this.render();
    try {
      const done = await this.registry[action](root);
      if (action === "start" && done === false) this.notify("addInfo", "open a Julia file in that folder to start its server.");
    } catch (e) {
      this.notify("addError", `could not ${action} the server: ${(e && e.message) || e}`);
    } finally {
      this.busy.delete(root);
      await this.refresh();
    }
  }

  async runAll() {
    try { await this.restartAll(); } catch (e) { this.notify("addError", `could not restart the servers: ${(e && e.message) || e}`); }
    await this.refresh();
  }

  // --- drawing ---------------------------------------------------------------------------------
  render() {
    const h = this.h;
    if (!this.registry.available) {
      this.summary.textContent = "Per-folder control is not available with this version of the language client.";
      h.replaceChildren(this.body, []);
      return;
    }
    const rows = this.rows();
    const running = rows.filter((r) => r.status === "running");
    const known = running.map((r) => this.memory.get(r.pid)).filter((b) => b != null);
    const total = known.length ? ` · ${formatBytes(known.reduce((a, b) => a + b, 0))}${known.length < running.length ? "+" : ""}` : "";
    this.summary.textContent = `${running.length} of ${rows.length} running${total}`;

    const header = h("div", { class: "row header" },
      h("span", { class: "name" }, "Project folder"), h("span", { class: "status" }, "Server"), h("span", { class: "pid" }, "PID"),
      h("span", { class: "memory", title: "Resident memory, including processes the server started" }, "Memory"),
      h("span", { class: "files", title: "Open Julia files that use this server" }, "Files"), h("span", { class: "actions" }));
    h.replaceChildren(this.body, [header, ...rows.map((r) => this.renderRow(r))]);
  }

  renderRow(r) {
    const h = this.h;
    const busy = this.busy.has(r.root);
    const button = (label, action, title) => h("button", { class: `btn btn-xs ${action}`, title, disabled: busy, onclick: () => this.run(r.root, action) }, label);
    const actions = r.status === "stopped"
      ? [button("Start", "start", "Start the server for the open Julia files in this folder")]
      : [button("Restart", "restart", "Stop the server and start a new one (reloads changed dependencies)"), button("Stop", "stop", "Shut the server down; its files lose language features until it starts again")];
    return h("div", { class: `row server ${r.status}${busy ? " busy" : ""}`, "data-root": r.root },
      h("span", { class: "name", title: r.root }, r.name),
      h("span", { class: "status" }, busy ? "working…" : r.status),
      h("span", { class: "pid" }, r.pid == null ? "–" : String(r.pid)),
      h("span", { class: "memory" }, r.status === "running" ? formatBytes(this.memory.get(r.pid)) : "–"),
      h("span", { class: "files" }, String(r.editors)),
      h("span", { class: "actions" }, actions));
  }
}

module.exports = { ServersPane, URI };
