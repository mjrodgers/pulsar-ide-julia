// Sanity checks for the parts of @savetheclocktower/atom-languageclient this package
// relies on (verified against its auto-languageclient.ts / languageclient.ts).
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");

describe("atom-languageclient fork API", () => {
  let client;

  beforeEach(() => {
    atom.project.setPaths([fixtures]);
    waitsForPromise({ timeout: 20000 }, () => activateJulia().then((mainModule) => { client = mainModule; }));
  });

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

  it("the live connection has onWorkspaceConfiguration()", () => {
    let connection;
    runs(() => {
      spyOn(client, "startServerProcess").andCallFake((projectPath) =>
        client.spawnChildNode([fakeServer], { cwd: projectPath }));
    });
    waitsForPromise({ timeout: 20000 }, () => atom.workspace.open(path.join(fixtures, "hello.jl")));
    waitsForPromise({ timeout: 20000 }, () => client.getConnectionForEditor(atom.workspace.getActiveTextEditor())
      .then((c) => { connection = c; }));
    runs(() => expect(typeof connection.onWorkspaceConfiguration).toBe("function"));
  });
});
