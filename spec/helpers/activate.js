// Shared by the specs that need Pulsar's package system.
//
// * The spec window does not see user-installed packages (a real `language-julia`
//   in ~/.pulsar/packages fails with "Failed to load package"), so everything is
//   activated by absolute path: a stub that provides the `source.julia` grammar,
//   and this package itself.
// * This package declares activationHooks/activationCommands, so Pulsar DEFERS its
//   activation: `activatePackage()` returns a promise that only settles once a hook
//   or command fires. We fire the hook ourselves, flush Pulsar's deferred-hook queue
//   (spec windows never run the normal startup that does this), and as a last
//   resort force the activation.
// * Spec windows mock setTimeout, so don't build timeouts out of it; rely on
//   waitsForPromise's own timeout instead.
//
// Debugging: PULSAR_IDE_JULIA_SPEC_TRACE=1 pulsar --test --timeout 60 spec/fork-api-spec.js
const path = require("path");

const packageRoot = path.join(__dirname, "..", "..");
const grammarStub = path.join(__dirname, "..", "fixtures", "language-julia-stub");
const ACTIVATION_HOOK = "source.julia:root-scope-used";

const trace = (msg) => {
  if (process.env.PULSAR_IDE_JULIA_SPEC_TRACE) process.stderr.write(`[spec trace] ${msg}\n`);
};

async function activateJulia() {
  try {
    trace(`activating grammar stub: ${grammarStub}`);
    await atom.packages.activatePackage(grammarStub);
    trace("grammar stub active");
  } catch (e) {
    throw new Error(`Could not activate the test grammar stub at ${grammarStub}: ${(e && e.stack) || e}`);
  }

  try {
    trace(`activating package: ${packageRoot}`);
    const activation = atom.packages.activatePackage(packageRoot);

    trace(`triggering activation hook ${ACTIVATION_HOOK}`);
    atom.packages.triggerActivationHook(ACTIVATION_HOOK);
    if (typeof atom.packages.triggerDeferredActivationHooks === "function") {
      trace("flushing deferred activation hooks");
      atom.packages.triggerDeferredActivationHooks();
    }

    const loaded = atom.packages.loadPackage(packageRoot);
    trace(`loaded package: ${loaded && loaded.name}; mainModule ready: ${!!(loaded && loaded.mainModule)}`);
    if (loaded && !loaded.mainModule && typeof loaded.activateNow === "function") {
      trace("hook did not activate the package; forcing activateNow()");
      loaded.activateNow();
    }

    const pkg = await activation;
    trace("package active");
    return pkg.mainModule;
  } catch (e) {
    throw new Error(`Could not activate pulsar-ide-julia from ${packageRoot}: ${(e && e.stack) || e}`);
  }
}

module.exports = { activateJulia, packageRoot, grammarStub, ACTIVATION_HOOK };
