// Sanity checks for the parts of @savetheclocktower/atom-languageclient this package
// relies on (verified against its auto-languageclient.ts / languageclient.ts).
const path = require("path");
const { activateJulia } = require("./helpers/activate");
const { useTimeout } = require("./helpers/timeout");

const fixtures = path.join(__dirname, "fixtures");
const fakeServer = path.join(fixtures, "fake-server.js");
const SLOW = 20000;

describe("atom-languageclient fork API", () => {
  let client;

  useTimeout(SLOW);

  beforeEach(async () => {
    atom.project.setPaths([fixtures]);
    client = await activateJulia();
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

  it("the live connection has onWorkspaceConfiguration()", async () => {
    spyOn(client, "startServerProcess").and.callFake((projectPath) =>
      client.spawnChildNode([fakeServer], { cwd: projectPath }));
    await atom.workspace.open(path.join(fixtures, "hello.jl"));
    const connection = await client.getConnectionForEditor(atom.workspace.getActiveTextEditor());
    expect(typeof connection.onWorkspaceConfiguration).toBe("function");
  });
});
