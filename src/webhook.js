import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';

const log = logger.child({ mod: 'webhook' });

/**
 * Sign a JSON body with HMAC-SHA256 (compatible with GitHub-style `sha256=<hex>` header).
 */
function sign(bodyString) {
  return 'sha256=' + createHmac('sha256', config.WEBHOOK_SECRET).update(bodyString).digest('hex');
}

/**
 * Single POST attempt. Returns { ok: boolean, statusCode?, err? }.
 */
async function postOnce(url, body, signature, event) {
  try {
    const { statusCode } = await request(url, {
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
    return { ok: statusCode < 400, statusCode };
  } catch (err) {
    return { ok: false, err: err.message };
  }
}

/**
 * Deliver an event to the configured webhook. Fire-and-forget (logs on failure).
 * Performs ONE retry after 2s if the first attempt fails or returns non-2xx.
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

  let result = await postOnce(url, body, signature, event);
  if (!result.ok) {
    log.warn({ event, url, statusCode: result.statusCode, err: result.err }, 'webhook attempt 1 failed — retrying in 2s');
    await new Promise((r) => setTimeout(r, 2000));
    result = await postOnce(url, body, signature, event);
    if (!result.ok) {
      log.warn({ event, url, statusCode: result.statusCode, err: result.err }, 'webhook delivery failed after retry');
      return;
    }
    log.info({ event, url, statusCode: result.statusCode }, 'webhook delivered on retry');
    return;
  }
  log.debug({ event, url, statusCode: result.statusCode }, 'webhook delivered');
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
