// Sanity checks for the parts of @savetheclocktower/atom-languageclient this package
// relies on (verified against its auto-languageclient.ts / languageclient.ts).
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { reportErrors } = require("./helpers/report");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("atom-languageclient fork API", () => {
  let client;

  useTimeout(SLOW);

  beforeEach(reportErrors(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia({
      prepare: (c) => spyOn(c, "startServerProcess").and.callFake((projectPath) =>
        c.spawnChildNode([fakeServer], { cwd: projectPath })),
    });
  }));

  for (const name of [
    "restartAllServers", "spawn", "spawnChildNode", "getInitializeParams",
    "supportsWorkspaceConfiguration", "getWorkspaceConfiguration",
    "getRootConfigurationKey", "mapConfigurationObject", "getConnectionForEditor",
  ]) {
    it(`AutoLanguageClient has ${name}()`, () => expect(typeof client[name]).toBe("function"));
  }

  it("advertises workspace/configuration support in initialize params", () => {
    const params = client.getInitializeParams(fixtures, { pid: 1 });
    expect(params.capabilities.workspace.configuration).toBe(true);
  });

  it("names Pulsar as the client and gives its own process id", () => {
    const params = client.getInitializeParams(fixtures, { pid: 1 });
    expect(params.clientInfo).toEqual({ name: "Pulsar", version: atom.getVersion() });
    expect(params.processId).toBe(process.pid);
  });

  it("forwards only the file changes JETLS watches", () => {
    expect(client.filterChangeWatchedFiles(path.join(fixtures, "hello.jl"))).toBe(true);
    expect(client.filterChangeWatchedFiles(path.join(fixtures, ".git", "index"))).toBe(false);
  });

  it("provides whole-file and on-save formatting", () => {
    for (const name of ["provideFileCodeFormat", "provideOnSaveCodeFormat"]) expect(typeof client[name]).toBe("function");
    const meta = require(path.join(__dirname, "..", "package.json")).providedServices;
    expect(meta["code-format.file"].versions["0.1.0"]).toBe("provideFileCodeFormat");
    expect(meta["code-format.onSave"].versions["0.1.0"]).toBe("provideOnSaveCodeFormat");
  });

  // lib/server/registry.js reaches into the fork's ServerManager; this checks it against the real one.
  it("can restart, stop and start one project folder's server", reportErrors(async () => {
    const servers = client.servers;
    expect(servers.available).toBe(true);
    const editor = await atom.workspace.open(path.join(fixtures, "hello.jl"));
    const connected = async () => {
      for (let i = 0; i < 400; i++) {
        if (await client.getConnectionForEditor(editor)) return true;
        await new Promise((r) => setImmediate(r));
      }
      return false;
    };
    expect(await connected()).toBe(true);
    const root = servers.rootOf(editor);
    const row = () => servers.list().find((r) => r.root === root);
    const first = row();
    expect(first.status).toBe("running");
    expect(first.editors).toBe(1);
    expect(typeof first.pid).toBe("number");

    expect(await servers.restart(root)).toBe(true);
    expect(row().status).toBe("running");
    expect(row().pid).not.toBe(first.pid);
    expect(await connected()).toBe(true);

    expect(await servers.stop(root)).toBe(true);
    expect(row().status).toBe("stopped");
    expect(await client.getConnectionForEditor(editor)).toBe(null);

    expect(await servers.start(root)).toBe(true);
    expect(row().status).toBe("running");
    expect(await connected()).toBe(true);
  }));

  it("the live connection has onWorkspaceConfiguration()", reportErrors(async () => {
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    const connection = await client.getConnectionForEditor(atom.workspace.getActiveTextEditor());
    expect(typeof connection.onWorkspaceConfiguration).toBe("function");
  }));
});
