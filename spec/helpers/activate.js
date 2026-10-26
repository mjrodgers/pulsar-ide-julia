// Shared by the specs that need Pulsar's package system.
//
// The spec window does not see user-installed packages (a real `language-julia`
// in ~/.pulsar/packages fails with "Failed to load package"), so everything is
// activated by absolute path: a stub that provides the `source.julia` grammar,
// and this package itself.
const path = require("path");

const packageRoot = path.join(__dirname, "..", "..");
const grammarStub = path.join(__dirname, "..", "fixtures", "language-julia-stub");

async function activateJulia() {
  try {
    await atom.packages.activatePackage(grammarStub);
  } catch (e) {
    throw new Error(`Could not activate the test grammar stub at ${grammarStub}: ${(e && e.stack) || e}`);
  }
  let pkg;
  try {
    pkg = await atom.packages.activatePackage(packageRoot);
  } catch (e) {
    throw new Error(`Could not activate pulsar-ide-julia from ${packageRoot}: ${(e && e.stack) || e}`);
  }
  return pkg.mainModule;
}

module.exports = { activateJulia, packageRoot, grammarStub };
