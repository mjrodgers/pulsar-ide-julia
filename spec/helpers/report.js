// Pulsar's Jasmine 2 runner appears to turn a rejected async beforeEach/it into a bare
// "Timeout - Async callback was not invoked" with no message. Print the real error
// first, then rethrow. (The returned function takes no declared parameters, so the
// runner does not mistake it for a spec that wants a `done` callback.)
function reportErrors(fn) {
  return async function (...args) {
    try {
      return await fn.apply(this, args);
    } catch (e) {
      process.stderr.write(`[spec error] ${(e && e.stack) || e}\n`);
      throw e;
    }
  };
}

module.exports = { reportErrors };
