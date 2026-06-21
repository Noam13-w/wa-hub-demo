import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const WEBHOOK_FILE = join(config.DATA_DIR, 'webhook.json');

/**
 * The Hub's single source of truth for instance state and event broadcasting.
 * Everything that needs to know "is the socket connected?" or "what was the last QR?"
 * reads from here. Everything that needs to react to incoming messages subscribes here.
 */
class HubState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    this.connection = 'disconnected'; // 'connecting' | 'qr' | 'connected' | 'disconnected'
    this.qr = null;                   // { dataUrl, expiresAt } when state === 'qr'
    this.me = null;                   // { jid, number, name } once connected
    this.startedAt = Date.now();
    this.lastEventAt = null;

    this.webhook = {
      url: null,
      events: [],
    };
  }

  setConnection(state, extra = {}) {
    this.connection = state;
    this.lastEventAt = Date.now();
    if (state === 'connected') {
      this.qr = null;
      this.me = extra.me ?? this.me;
      this.emit('instance.connected', { me: this.me });
    } else if (state === 'disconnected') {
      // Clear identity + any stale QR so /status and /qr don't keep reporting a
      // paired device (or an expired QR) while we're actually offline.
      this.me = null;
      this.qr = null;
      this.emit('instance.disconnected', { reason: extra.reason });
    } else if (state === 'qr') {
      this.qr = extra.qr;
      this.emit('instance.qr', { qr: this.qr });
    }
  }

  setWebhook({ url, events }, { persist = true } = {}) {
    this.webhook = {
      url: url || null,
      events: Array.isArray(events) ? events : [],
    };
    if (persist) persistWebhook(this.webhook);
  }
}

function persistWebhook(webhook) {
  try {
    mkdirSync(config.DATA_DIR, { recursive: true });
    writeFileSync(WEBHOOK_FILE, JSON.stringify(webhook, null, 2), 'utf8');
  } catch (err) {
    // Swallow — webhook persistence is a nice-to-have, not critical.
    // eslint-disable-next-line no-console
    console.warn(`[state] failed to persist webhook config: ${err.message}`);
  }
}

/**
 * Load webhook config from disk if present. Returns null when no file exists
 * or the file is unreadable. Callers should fall back to the env config.
 */
export function loadPersistedWebhook() {
  try {
    const raw = readFileSync(WEBHOOK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      url: parsed.url || null,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return null;
  }
}

export const state = new HubState();
