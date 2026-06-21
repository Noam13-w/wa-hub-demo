import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';
import { incrPending, decrPending, recordWebhookFailure } from './diagnostics.js';

const log = logger.child({ mod: 'webhook' });

// Exponential backoff schedule, in milliseconds. Index = attempt - 1.
// Total worst case: ~26 s wall-clock (0 + 2 + 6 + 18). Still fire-and-forget.
const BACKOFF_MS = [0, 2_000, 6_000, 18_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

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
async function postOnce(url, body, signature, event) {
  const start = Date.now();
  try {
    const { statusCode, body: resBody } = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': signature,
        'x-hub-event': event,
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
    return { ok: false, err: err.message, ms: Date.now() - start };
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

  const payload = {
    event,
    timestamp: Date.now(),
    instance: config.HUB_NAME,
    data,
  };
  const body = JSON.stringify(payload);
  const signature = sign(body);

  incrPending();
  const startedAt = Date.now();
  let lastResult = null;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = BACKOFF_MS[attempt - 1];
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      lastResult = await postOnce(url, body, signature, event);

      // Structured log per attempt (useful for tracing tail-latency).
      log.info(
        {
          event,
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
