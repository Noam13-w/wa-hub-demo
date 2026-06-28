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
// How many tasks are queued-or-running right now. Bounded by config.SEND_QUEUE_MAX
// so a flood of senders (esp. with pacing enabled, where each task takes seconds)
// can't grow the chain — and the retained request/media buffers behind it —
// without limit. Past the cap we shed with a 503 instead of buffering forever.
let pending = 0;

// Mild bell-ish jitter (average of two uniforms) so gaps cluster around the mean
// instead of being uniformly random — closer to human cadence.
function jitter(min, max) {
  if (max <= min) return min;
  const u = (Math.random() + Math.random()) / 2;
  return Math.floor(min + u * (max - min));
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Shared core: serialize `fn` onto the global FIFO, apply the inter-send gap, and
// (for real message sends) an optional typing indicator. Throws a 503 synchronously
// when the queue is saturated. `jid`/`textLen` only matter when `typing` is on.
function enqueue(jid, fn, { textLen = 0, typing = false } = {}) {
  if (pending >= config.SEND_QUEUE_MAX) {
    const err = new Error('send_queue_full');
    err.status = 503;
    err.code = 'send_queue_full';
    throw err;
  }
  pending += 1;

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
  // Release the slot when this task settles (separate from the tail chain so a
  // caller's rejection doesn't double-count).
  run.then(() => { pending -= 1; }, () => { pending -= 1; });
  return run;
}

/**
 * Enqueue a real message SEND. `fn` performs the actual `sendMessage(...)` and its
 * resolved value is returned to the caller. `jid` + `textLen` drive the optional
 * typing indicator. Errors propagate to the caller but never wedge the queue.
 * Throws a 503 (`send_queue_full`) synchronously when the queue is saturated.
 *
 * @param {string} jid          destination jid (for the typing indicator)
 * @param {() => Promise<any>} fn the work to run when this slot is reached
 * @param {{textLen?: number, typing?: boolean}} [opts]
 */
export function pacedSend(jid, fn, opts = {}) {
  return enqueue(jid, fn, { textLen: opts.textLen ?? 0, typing: opts.typing ?? config.SEND_TYPING });
}

/**
 * Serialize a non-message, ban-sensitive WhatsApp action (group lifecycle ops,
 * presence, markRead, …) through the SAME FIFO + inter-op gap as message sends —
 * so concurrent callers can't fire a burst of group/admin actions at WhatsApp —
 * but WITHOUT a typing indicator. Same 503 shedding as pacedSend.
 */
export function pacedRun(fn) {
  return enqueue(null, fn, { typing: false });
}
