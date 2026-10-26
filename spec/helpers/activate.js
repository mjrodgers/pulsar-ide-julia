// Shared by the specs that need Pulsar's package system.
//
// * The spec window does not see user-installed packages (a real `language-julia`
//   in ~/.pulsar/packages fails with "Failed to load package"), so everything is
//   activated by absolute path: a stub that provides the `source.julia` grammar,
//   and this package itself.
// * This package declares activationHooks/activationCommands, so Pulsar DEFERS its
//   activation: `activatePackage()` returns a promise that only settles once a hook
//   or command fires. We fire the hook ourselves.
const path = require("path");

const packageRoot = path.join(__dirname, "..", "..");
const grammarStub = path.join(__dirname, "..", "fixtures", "language-julia-stub");
const ACTIVATION_HOOK = "source.julia:root-scope-used";

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function activateJulia({ timeout = 15000 } = {}) {
  try {
    await withTimeout(
      atom.packages.activatePackage(grammarStub), timeout,
      `Activating the test grammar stub at ${grammarStub} did not finish in ${timeout}ms`);
  } catch (e) {
    throw new Error(`Could not activate the test grammar stub: ${(e && e.stack) || e}`);
  }

  let pkg;
  try {
    const activation = atom.packages.activatePackage(packageRoot);
    atom.packages.triggerActivationHook(ACTIVATION_HOOK);
    pkg = await withTimeout(
      activation, timeout,
      `pulsar-ide-julia did not finish activating in ${timeout}ms after triggering "${ACTIVATION_HOOK}". ` +
      "Check that the hook name in package.json's activationHooks matches.");
  } catch (e) {
    throw new Error(`Could not activate pulsar-ide-julia from ${packageRoot}: ${(e && e.stack) || e}`);
  }
  return pkg.mainModule;
}

module.exports = { activateJulia, packageRoot, grammarStub, ACTIVATION_HOOK };
