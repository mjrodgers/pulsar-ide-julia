// The JETLS servers the language client runs (one per project root) and per-root control over them.
//
// The fork has public calls for "restart everything" only, so this reaches into its ServerManager
// (`client._serverManager`: private in its TypeScript, plain properties at runtime). Everything it uses is checked by
// `available`; if a fork update renames something, the commands fall back to restarting all servers instead of
// breaking. The calls it relies on, from server-manager.ts (1.18.0):
//   getActiveServers() -> [{projectPath, process: {pid}}]       _startingServerPromises: Map<root, Promise<server>>
//   getNormalizedProjectPaths() -> roots, with a trailing separator
//   stopServer(server)   shuts the server down without the auto-restart that a crash gets
//   _handleTextEditor(editor)   maps an editor to its root's server, starting it if needed (what the manager does
//                               for every editor it sees open, so it is also how a stopped root is brought back)
const path = require("path");

const displayName = (root) => path.basename(String(root).replace(/[\\/]+$/, "")) || String(root);

class ServerRegistry {
  // client: the AutoLanguageClient; workspace: getTextEditors(); isJulia(editor) -> bool
  constructor({ client, workspace, isJulia }) {
    this.client = client;
    this.workspace = workspace;
    this.isJulia = isJulia;
  }

  get manager() {
    return this.client && this.client._serverManager;
  }

  // True when everything below can be done for a single root.
  get available() {
    const m = this.manager;
    return !!m && ["getActiveServers", "getNormalizedProjectPaths", "stopServer", "_handleTextEditor"].every((k) => typeof m[k] === "function") &&
      m._startingServerPromises instanceof Map && typeof this.client.determineProjectPath === "function";
  }

  // The root the language client uses for an editor (its project folder, or the root of a server that claimed the
  // file through go-to-definition), or null.
  rootOf(editor) {
    if (!editor || !editor.getPath || !editor.getPath()) return null;
    try { return this.client.determineProjectPath(editor) || null; } catch (e) { return null; }
  }

  juliaEditorsOf(root) {
    return this.workspace.getTextEditors().filter((e) => this.isJulia(e) && this.rootOf(e) === root);
  }

  // One row per project root and per running server outside them:
  //   {root, name, status: "running" | "starting" | "stopped", pid, editors}
  list() {
    const m = this.manager;
    const servers = m.getActiveServers();
    const starting = [...m._startingServerPromises.keys()];
    const roots = [...m.getNormalizedProjectPaths()];
    for (const r of [...servers.map((s) => s.projectPath), ...starting]) if (!roots.includes(r)) roots.push(r);
    return roots.map((root) => {
      const server = servers.find((s) => s.projectPath === root);
      const status = server ? "running" : starting.includes(root) ? "starting" : "stopped";
      const pid = server && server.process && typeof server.process.pid === "number" ? server.process.pid : null;
      return { root, name: displayName(root), status, pid, editors: this.juliaEditorsOf(root).length };
    });
  }

  // The running server of a root, waiting for one that is still starting. Null if there is none.
  async serverFor(root) {
    const m = this.manager;
    const running = m.getActiveServers().find((s) => s.projectPath === root);
    if (running) return running;
    const pending = m._startingServerPromises.get(root);
    if (!pending) return null;
    try { return await pending; } catch (e) { return null; }
  }

  // Shuts the root's server down. Its editors keep their text but lose language features until `start`.
  async stop(root) {
    const server = await this.serverFor(root);
    if (!server) return false;
    await this.manager.stopServer(server);
    return true;
  }

  // Starts the root's server again for its open Julia editors. Returns false when there are none (a server with no
  // editors would only be stopped again by the manager).
  async start(root) {
    const editors = this.juliaEditorsOf(root);
    if (editors.length === 0) return false;
    await Promise.all(editors.map((e) => this.manager._handleTextEditor(e)));
    return true;
  }

  async restart(root) {
    await this.stop(root);
    return this.start(root);
  }
}

module.exports = { ServerRegistry, displayName };
