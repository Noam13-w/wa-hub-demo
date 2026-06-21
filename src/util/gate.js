/**
 * Tiny in-process concurrency gate.
 *
 * Caps how many expensive operations (e.g. base64 media decode + Baileys upload)
 * run at once, so a burst of large requests can't pile up enough simultaneous
 * multi-MB Buffers to blow past the 512 MB process cap (CWE-400). Excess callers
 * wait; if the wait queue itself gets too deep we shed load with a 503 rather
 * than buffering unbounded work.
 */
export function createGate(maxConcurrent, maxQueue) {
  let active = 0;
  const waiters = [];

  return {
    async run(fn) {
      if (active >= maxConcurrent) {
        if (waiters.length >= maxQueue) {
          const err = new Error('server_busy');
          err.status = 503;
          err.code = 'server_busy';
          throw err;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        const next = waiters.shift();
        if (next) next();
      }
    },
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}
