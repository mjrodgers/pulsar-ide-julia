// Shared by the specs that need Pulsar's package system.
//
// * The spec window does not see user-installed packages (a real `language-julia`
//   in ~/.pulsar/packages fails with "Failed to load package"), so everything is
//   activated by absolute path: a stub that provides the `source.julia` grammar,
//   and this package itself.
// * This package declares activationHooks/activationCommands, so Pulsar DEFERS its
//   activation: `activatePackage()` returns a promise that only settles once a hook
//   or command fires. We fire the hook ourselves and flush Pulsar's deferred-hook
//   queue (spec windows never run the normal startup that does this).
// * On activation the fork starts servers for editors that are ALREADY open. So
//   leftover editors are closed first, and `prepare(client)` runs before anything is
//   activated: install spies there, or a real `jetls` can be launched by mistake.
//
// Debugging: PULSAR_IDE_JULIA_SPEC_TRACE=1 pulsar --test --timeout 60 spec/activation-spec.js
const path = require("path");

const packageRoot = path.join(__dirname, "..", "..");
const grammarStub = path.join(__dirname, "..", "fixtures", "language-julia-stub");
const ACTIVATION_HOOK = "source.julia:root-scope-used";

const trace = (msg) => {
  if (process.env.PULSAR_IDE_JULIA_SPEC_TRACE) process.stderr.write(`[spec trace] ${msg}\n`);
};

async function activateJulia({ prepare } = {}) {
  // Nothing may be open when the package activates.
  for (const item of atom.workspace.getPaneItems()) {
    try { if (item.destroy) item.destroy(); } catch (e) { /* ignore */ }
  }

  // The package's main module is a singleton; the spec and Pulsar's package loader
  // share it through the module cache. Spies go on it before activation.
  const client = require(path.join(packageRoot, "lib", "main"));
  if (prepare) prepare(client);

  try {
    trace(`activating grammar stub: ${grammarStub}`);
    await atom.packages.activatePackage(grammarStub);
    trace("grammar stub active");
  } catch (e) {
    throw new Error(`Could not activate the test grammar stub at ${grammarStub}: ${(e && e.stack) || e}`);
  }

  let pkg;
  try {
    trace(`activating package: ${packageRoot}`);
    const activation = atom.packages.activatePackage(packageRoot);
    trace(`triggering activation hook ${ACTIVATION_HOOK}`);
    atom.packages.triggerActivationHook(ACTIVATION_HOOK);
    if (typeof atom.packages.triggerDeferredActivationHooks === "function") {
      atom.packages.triggerDeferredActivationHooks();
    }
    const loaded = atom.packages.loadPackage(packageRoot);
    if (loaded && !loaded.mainModule && typeof loaded.activateNow === "function") {
      trace("hook did not activate the package; forcing activateNow()");
      loaded.activateNow();
    }
    pkg = await activation;
    trace("package active");
  } catch (e) {
    throw new Error(`Could not activate pulsar-ide-julia from ${packageRoot}: ${(e && e.stack) || e}`);
  }

  if (pkg.mainModule !== client) {
    throw new Error(
      "The spec's require() and Pulsar's package loader returned different client instances, " +
      "so spies installed before activation are on the wrong object.");
  }
  return client;
}

module.exports = { activateJulia, trace, packageRoot, grammarStub, ACTIVATION_HOOK };
