import { EventEmitter } from 'node:events';

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
      this.emit('instance.disconnected', { reason: extra.reason });
    } else if (state === 'qr') {
      this.qr = extra.qr;
      this.emit('instance.qr', { qr: this.qr });
    }
  }

  setWebhook({ url, events }) {
    this.webhook = {
      url: url || null,
      events: Array.isArray(events) ? events : [],
    };
  }
}

export const state = new HubState();
