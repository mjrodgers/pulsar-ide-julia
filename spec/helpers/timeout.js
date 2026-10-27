// Pulsar's Jasmine 2 runner wraps `it`/`beforeEach` and does not pass a per-spec
// timeout argument through (a spec given 20s still timed out at the 5s default),
// so raise the global default for the enclosing describe block instead.
// Call inside a `describe`, BEFORE its other beforeEach hooks.
function useTimeout(ms) {
  let original;
  beforeEach(() => {
    original = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = ms;
  });
  afterEach(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = original;
  });
}

module.exports = { useTimeout };
