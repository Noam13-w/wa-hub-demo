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
 * Deliver an event to the configured webhook. Fire-and-forget (logs on failure).
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
    if (statusCode >= 400) {
      log.warn({ event, url, statusCode }, 'webhook returned non-2xx');
    } else {
      log.debug({ event, url, statusCode }, 'webhook delivered');
    }
  } catch (err) {
    log.warn({ event, url, err: err.message }, 'webhook delivery failed');
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
