// A promise you can settle from outside. Specs await these instead of polling,
// because spec windows mock setTimeout/setInterval.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // awaiters still see the rejection; no unhandled-rejection noise
  return { promise, resolve, reject };
}

module.exports = { deferred };
