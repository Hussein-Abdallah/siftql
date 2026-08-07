/**
 * Runs a native RegExp off the main thread.
 *
 * A catastrophic pattern cannot be interrupted once it starts — there is no
 * yield point to cancel at, and no timeout inside the language that will stop
 * it. Running it here means the page can `terminate()` the whole thread and
 * survive, which is the only honest way to demonstrate the cost without
 * destroying the demo that is demonstrating it.
 *
 * That escape hatch is also the argument: a browser tab has a worker to throw
 * away, and a Node server handling a request does not.
 */
self.addEventListener('message', (event) => {
  const { pattern, subject } = event.data;
  const started = performance.now();

  new RegExp(pattern).test(subject);

  self.postMessage({ ms: performance.now() - started });
});
