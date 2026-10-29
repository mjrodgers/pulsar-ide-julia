// Pulsar started from the Dock, Spotlight or a desktop launcher reads your login shell's environment (PATH included) in
// the background, shortly after the window opens. This package can be activated before that, by opening a Julia file,
// and then `process.env.PATH` is still the bare system PATH: no juliaup, Homebrew or ~/.julia/bin, so `jetls` or `julia`
// would not be found. Waiting for the shell environment first rules that out.
//
// Node's own timers: Pulsar's spec runner replaces the window's with a mock clock.
const { setTimeout, clearTimeout } = require("timers");

const TIMEOUT = 10000;

// Resolves with true once Pulsar has loaded the shell environment, or false after `timeout` ms (a slow or broken shell
// startup file must not keep the server from starting; it then starts with the environment Pulsar has).
function waitForShellEnvironment({ api = global.atom, timeout = TIMEOUT } = {}) {
  if (!api || typeof api.whenShellEnvironmentLoaded !== "function") return Promise.resolve(true);
  // Spec windows never load it (the specs run with the environment of the shell that started them).
  if (typeof api.inSpecMode === "function" && api.inSpecMode()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let subscription = null;
    let timer = null;
    const finish = (loaded) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (subscription && typeof subscription.dispose === "function") subscription.dispose();
      resolve(loaded);
    };
    timer = setTimeout(() => finish(false), timeout);
    // Called at once when the environment is already loaded.
    subscription = api.whenShellEnvironmentLoaded(() => finish(true));
    if (done && subscription && typeof subscription.dispose === "function") subscription.dispose();
  });
}

// The same wait, shared by everything that starts a process, and done at most once per window: after a timeout,
// later starts do not wait again.
let shared = null;
function shellEnvironment(options) {
  if (!shared) shared = waitForShellEnvironment(options);
  return shared;
}
shellEnvironment.reset = () => { shared = null; };

module.exports = { waitForShellEnvironment, shellEnvironment, TIMEOUT };
