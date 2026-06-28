import { createHmac, randomUUID } from 'node:crypto';
import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';
import { incrPending, decrPending, recordWebhookFailure } from './diagnostics.js';
import { assertSafeUrl, guardedAgent } from './net/egress.js';
import { createGate } from './util/gate.js';

const log = logger.child({ mod: 'webhook' });

// Exponential backoff schedule, in milliseconds. Index = attempt - 1.
// Total worst case: ~26 s wall-clock (0 + 2 + 6 + 18). Still fire-and-forget.
const BACKOFF_MS = [0, 2_000, 6_000, 18_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

// Bound concurrent in-flight deliveries (and the backlog behind them) so a slow or
// failing receiver during an inbound burst can't accumulate unbounded retained
// bodies, ~26 s retry timers, and sockets. Past the backlog cap we SHED rather
// than buffer. Concurrency >1 (not a strict FIFO) avoids one failing event head-of-
// line-blocking all others for the full retry window; ordering is instead made
// recoverable by the monotonic per-event sequence number in the signed envelope.
const deliveryGate = createGate(config.WEBHOOK_CONCURRENCY, config.WEBHOOK_MAX_QUEUE);

// Monotonic, per-process delivery sequence. Included in the SIGNED envelope and the
// x-hub-sequence header so receivers can order events and detect gaps. Resets to 0
// on restart (document delivery as at-least-once, unordered-but-sequenced).
let seqCounter = 0;

/**
 * Sign a JSON body with HMAC-SHA256 (compatible with GitHub-style `sha256=<hex>` header).
 */
function sign(bodyString) {
  return 'sha256=' + createHmac('sha256', config.WEBHOOK_SECRET).update(bodyString).digest('hex');
}

/**
 * Decide whether to retry. Retry on:
 *   - network/connect errors (no statusCode)
 *   - 5xx responses
 *   - 408 / 429 (request timeout / rate limited — transient on the receiver)
 * NEVER retry on other 4xx: the receiver has rejected the payload as malformed
 * or unauthorized — retrying doesn't help and just wastes resources.
 */
function isRetryable(result) {
  if (result.ok) return false;
  const sc = result.statusCode;
  if (sc === undefined || sc === null) return true; // network error
  if (sc >= 500 && sc <= 599) return true;
  if (sc === 408 || sc === 429) return true;
  return false;
}

/**
 * Single POST attempt. Returns { ok: boolean, statusCode?, err?, ms }.
 */
async function postOnce(url, body, signature, event, headers) {
  const start = Date.now();
  try {
    const { statusCode, body: resBody } = await request(url, {
      method: 'POST',
      // SSRF guard: refuse connections that resolve to private/reserved
      // addresses (no-op when ALLOW_PRIVATE_EGRESS is set). Never follow
      // redirects — a 3xx to an internal target would bypass the URL check.
      dispatcher: guardedAgent(),
      maxRedirections: 0,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': signature,
        'x-hub-event': event,
        'x-hub-timestamp': headers.timestamp,
        'x-hub-delivery': headers.delivery,
        'x-hub-sequence': headers.seq,
        'user-agent': `wa-hub-demo/${config.HUB_NAME}`,
      },
      body,
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    });
    // Drain the response body so undici returns the socket to its pool — an
    // unconsumed body leaks the connection and stalls delivery under load.
    try { await resBody.dump(); } catch { /* ignore */ }
    return { ok: statusCode < 400, statusCode, ms: Date.now() - start };
  } catch (err) {
    // Store the short error code, not the verbose message — the failure buffer
    // is reachable via the API and raw connect errors are an SSRF probe oracle.
    return { ok: false, err: err.code || 'request_failed', ms: Date.now() - start };
  }
}

/**
 * Deliver an event to the configured webhook. Fire-and-forget.
 *
 * Retry policy: up to 4 attempts (immediate, +2s, +6s, +18s) but ONLY on
 * 5xx, 408, 429, or network errors. 4xx (other) is a client error — we
 * stop immediately and log the failure to the disk-backed buffer.
 *
 * Filtering: if `state.webhook.events` is non-empty, only those events are delivered.
 */
async function deliver(event, data) {
  const url = state.webhook.url;
  if (!url) return;
  const filter = state.webhook.events;
  if (filter.length > 0 && !filter.includes(event)) return;

  // Re-validate the persisted URL at delivery time (scheme + literal private IP).
  // The connect-time guard in postOnce additionally defeats DNS rebinding.
  try {
    assertSafeUrl(url);
  } catch (err) {
    recordWebhookFailure({ event, url, attempts: 0, lastStatus: null, lastError: err.code || 'invalid_url', totalMs: 0 });
    log.warn({ event, url, err: err.code }, 'webhook delivery skipped — URL failed egress policy');
    return;
  }

  const timestamp = Date.now();
  const seq = ++seqCounter;
  const payload = {
    event,
    seq,
    timestamp,
    instance: config.HUB_NAME,
    data,
  };
  const body = JSON.stringify(payload);
  const signature = sign(body);
  // Per-delivery id lets receivers dedup retries (replay protection alongside
  // the timestamp). Same id + seq are reused across this delivery's retry attempts.
  const deliveryHeaders = { timestamp: String(timestamp), delivery: randomUUID(), seq: String(seq) };

  incrPending();
  const startedAt = Date.now();

  try {
    await deliveryGate.run(async () => {
      let lastResult = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const wait = BACKOFF_MS[attempt - 1];
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        lastResult = await postOnce(url, body, signature, event, deliveryHeaders);

        // Structured log per attempt (useful for tracing tail-latency).
        log.info(
          {
            event,
            seq,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            statusCode: lastResult.statusCode,
            ok: lastResult.ok,
            ms: lastResult.ms,
            err: lastResult.err,
          },
          lastResult.ok ? 'webhook delivered' : 'webhook attempt failed',
        );

        if (lastResult.ok) return;
        if (!isRetryable(lastResult)) {
          log.warn(
            { event, statusCode: lastResult.statusCode, err: lastResult.err },
            'webhook delivery aborted — receiver returned non-retryable status',
          );
          break;
        }
      }

      // Got here → all attempts exhausted or aborted early.
      recordWebhookFailure({
        event,
        url,
        attempts: MAX_ATTEMPTS,
        lastStatus: lastResult?.statusCode,
        lastError: lastResult?.err,
        totalMs: Date.now() - startedAt,
      });
      log.warn(
        { event, url, statusCode: lastResult?.statusCode, err: lastResult?.err, totalMs: Date.now() - startedAt },
        'webhook delivery FAILED — recorded to webhook-failures.json',
      );
    });
  } catch (err) {
    // The only thing deliveryGate.run throws (the inner loop swallows its own
    // errors) is the 503 load-shed when the backlog is full.
    const shed = err?.code === 'server_busy';
    recordWebhookFailure({
      event,
      url,
      attempts: 0,
      lastStatus: null,
      lastError: shed ? 'shed_backlog_full' : (err?.code || 'delivery_error'),
      totalMs: Date.now() - startedAt,
    });
    log.warn(
      { event, url, err: err?.code || err?.message },
      shed
        ? 'webhook delivery SHED — backlog full (raise WEBHOOK_MAX_QUEUE or fix the slow receiver)'
        : 'webhook delivery error',
    );
  } finally {
    decrPending();
  }
}

/**
 * Wire the state's events into the webhook dispatcher.
 */
export function attachWebhookListeners() {
  state.on('message.incoming', (m) => deliver('message.incoming', m));
  state.on('message.outgoing', (m) => deliver('message.outgoing', m));
  state.on('message.status', (m) => deliver('message.status', m));
  state.on('instance.connected', (m) => deliver('instance.connected', m));
  state.on('instance.disconnected', (m) => deliver('instance.disconnected', m));
  state.on('instance.qr', (m) => deliver('instance.qr', { /* never leak the QR over webhook */ generatedAt: Date.now() }));
}
