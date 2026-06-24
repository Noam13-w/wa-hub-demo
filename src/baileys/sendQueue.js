import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSocket } from './socket.js';

const log = logger.child({ mod: 'sendq' });

/**
 * Global outbound-send pacing.
 *
 * Every WhatsApp send funnels through a single FIFO promise-chain so concurrent
 * callers can never fire a burst at WhatsApp (high velocity / robotic timing is
 * the #1 mechanical ban trigger — and the per-IP HTTP rate limiter does NOT bound
 * the account's true send rate). Between sends we can insert a randomized gap and
 * an optional "typing" chatstate to look human.
 *
 * Pacing is OFF by default (SEND_MIN_DELAY_MS=0) — the queue then only serializes,
 * which is free and safe. Operators harden a real number via the SEND_* config.
 */
let tail = Promise.resolve();
let lastSendAt = 0;

// Mild bell-ish jitter (average of two uniforms) so gaps cluster around the mean
// instead of being uniformly random — closer to human cadence.
function jitter(min, max) {
  if (max <= min) return min;
  const u = (Math.random() + Math.random()) / 2;
  return Math.floor(min + u * (max - min));
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Enqueue a send. `fn` performs the actual `getSocket().sendMessage(...)` (or any
 * outbound action) and its resolved value is returned to the caller. `jid` +
 * `textLen` drive the optional typing indicator. Errors propagate to the caller
 * but never wedge the queue.
 *
 * @param {string} jid          destination jid (for the typing indicator)
 * @param {() => Promise<any>} fn the work to run when this slot is reached
 * @param {{textLen?: number, typing?: boolean}} [opts]
 */
export function pacedSend(jid, fn, opts = {}) {
  const textLen = opts.textLen ?? 0;
  const typing = opts.typing ?? config.SEND_TYPING;

  const run = tail.then(async () => {
    // 1. Honour the minimum gap since the previous send.
    const min = config.SEND_MIN_DELAY_MS;
    const max = config.SEND_MAX_DELAY_MS || min;
    const gap = jitter(min, max);
    if (gap > 0) {
      const since = Date.now() - lastSendAt;
      if (since < gap) await sleep(gap - since);
    }

    // 2. Optional typing indicator before the send.
    if (typing && jid) {
      try {
        const sock = getSocket();
        if (sock) {
          await sock.sendPresenceUpdate('composing', jid);
          const typeMs = Math.min(config.SEND_TYPING_MAX_MS, Math.max(400, textLen * config.SEND_TYPING_MS_PER_CHAR));
          await sleep(typeMs);
          await sock.sendPresenceUpdate('paused', jid);
        }
      } catch (err) {
        log.warn({ err: err.message }, 'typing presence failed — sending anyway');
      }
    }

    try {
      return await fn();
    } finally {
      lastSendAt = Date.now();
    }
  });

  // The queue tail must advance regardless of whether this task resolved or threw.
  tail = run.then(() => {}, () => {});
  return run;
}
