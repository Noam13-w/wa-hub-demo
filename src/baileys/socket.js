import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import baileys, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { state } from '../state.js';
import { normalizeMessage } from './normalize.js';

const log = logger.child({ mod: 'baileys' });
const makeWASocket = baileys.default ?? baileys;

let sock = null;
let reconnectAttempts = 0;
let stableTimer = null;
let reconnectTimer = null;
// True once we've reached a live ('open') connection at least once. Used to tell
// normal QR-pairing churn (fast, benign) apart from a real connection that dropped
// (where exponential backoff is appropriate). Reset on resetAuth() so re-pairing
// after a logout gets the fast QR cadence again.
let everConnected = false;

const AUTH_DIR = join(config.DATA_DIR, 'auth');

/**
 * Returns the active socket, or null if not yet connected.
 * REST routes use this; they should respond 503 if null.
 */
export function getSocket() {
  return sock;
}

/**
 * Cleanly close the socket without wiping auth. Used by graceful shutdown.
 */
export async function closeSocket() {
  // Cancel any pending reconnect/stable timers so they don't fire after shutdown.
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.end(undefined);
  } catch (err) {
    log.warn({ err: err.message }, 'closeSocket: ignored error');
  }
  sock = null;
}

/**
 * Wipe the auth state and force a fresh QR pairing. Used by POST /api/instance/logout.
 */
export async function resetAuth() {
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { await rm(AUTH_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(new Error('manual logout')); } catch { /* ignore */ }
    sock = null;
  }
  reconnectAttempts = 0;
  everConnected = false;
  await startSocket();
}

/**
 * Boot the Baileys socket. Idempotent — safe to call from index.js once.
 */
export async function startSocket() {
  // If a previous socket is still around (e.g. a reconnect after a half-open
  // close), detach its listeners and end it so we never leak sockets/listeners.
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch { /* ignore */ }
    sock = null;
  }
  await mkdir(AUTH_DIR, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.info({ version, isLatest }, 'using Baileys protocol version');

  sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger.child({ mod: 'baileys.keys', level: 'warn' })),
    },
    logger: logger.child({ mod: 'baileys.lib', level: 'warn' }),
    browser: Browsers.macOS(config.HUB_NAME),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => handleConnectionUpdate(update));
  sock.ev.on('messages.upsert', (evt) => handleMessagesUpsert(evt));
  sock.ev.on('messages.update', (updates) => handleMessageStatusUpdate(updates));

  return sock;
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    state.setConnection('qr', { qr: { dataUrl, expiresAt: Date.now() + 60_000 } });
    log.info('QR generated — pair the device within 60s');
  }

  if (connection === 'connecting') {
    state.setConnection('connecting');
  }

  if (connection === 'open') {
    reconnectAttempts = 0;
    everConnected = true;
    const me = sock?.user
      ? {
          jid: jidNormalizedUser(sock.user.id),
          number: sock.user.id.split(':')[0],
          name: sock.user.name || sock.user.verifiedName || null,
        }
      : null;
    state.setConnection('connected', { me });
    log.info({ me }, '✅ WhatsApp connected');

    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { reconnectAttempts = 0; }, 30_000);
  }

  if (connection === 'close') {
    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;
    // 440 = connectionReplaced — another session took over this device.
    // Reconnecting would just trigger a war between the two sessions; abort.
    const replaced = code === DisconnectReason.connectionReplaced || code === 440;
    log.warn({ code, loggedOut, replaced, reason: lastDisconnect?.error?.message }, 'WhatsApp connection closed');
    state.setConnection('disconnected', { reason: lastDisconnect?.error?.message });

    if (loggedOut) {
      log.error('Device was logged out from the phone. Clear /data/auth and re-pair.');
      return;
    }
    if (replaced) {
      log.error('Another session replaced this one (code 440). Not reconnecting — re-pair to take over.');
      return;
    }

    // QR-pairing churn vs a dropped live connection. While we've NEVER linked a
    // device, Baileys ends the socket with 408 (timedOut — "QR refs attempts
    // ended") once it burns through a batch of QR codes, or 515 (restartRequired)
    // right after a successful scan. Both are normal pairing steps, not a flaky
    // link — so re-arm a fresh QR almost immediately and do NOT feed the
    // exponential backoff. Otherwise reconnectAttempts climbs (it only resets on a
    // real 'open'), backoff saturates at 60s, and during those gaps /api/instance/qr
    // serves nothing so the /pair page is stuck on "Waiting for a fresh QR…".
    const transient = code === DisconnectReason.timedOut || code === DisconnectReason.restartRequired;
    if (!everConnected && transient) {
      log.info({ code }, 'QR cycle ended while unpaired — re-arming a fresh QR');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startSocket().catch((err) => log.error({ err }, 'QR re-arm failed'));
      }, 1000);
      return;
    }

    reconnectAttempts += 1;
    const backoff = Math.min(60_000, 1000 * 2 ** Math.min(reconnectAttempts, 6));
    log.info({ reconnectAttempts, backoffMs: backoff }, 'reconnecting...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startSocket().catch((err) => log.error({ err }, 'reconnect failed'));
    }, backoff);
  }
}

// Human-readable mapping for Baileys' numeric ack statuses.
// See proto WAMessageStatus: 0=ERROR 1=PENDING 2=SERVER_ACK 3=DELIVERY_ACK 4=READ 5=PLAYED
const STATUS_LABELS = {
  0: 'error',
  1: 'pending',
  2: 'sent',       // ✓ — server received it
  3: 'delivered', // ✓✓ — phone delivered it
  4: 'read',       // ✓✓ blue — recipient opened it
  5: 'played',     // voice note played
};

function handleMessagesUpsert({ messages, type }) {
  if (type !== 'notify' && type !== 'append') return;
  for (const raw of messages) {
    const m = normalizeMessage(raw);
    if (!m) continue;
    if (m.fromMe) {
      state.emit('message.outgoing', m);
    } else {
      state.emit('message.incoming', m);
    }
  }
}

function handleMessageStatusUpdate(updates) {
  for (const u of updates) {
    const code = u.update?.status;
    if (code === undefined || code === null) continue;
    state.emit('message.status', {
      id: u.key?.id,
      chat: u.key?.remoteJid,
      fromMe: u.key?.fromMe ?? null,
      status: STATUS_LABELS[code] || 'unknown',
      statusCode: code, // keep the raw code for clients who want it
    });
  }
}

// Expose for tests / external translation if ever needed.
export { STATUS_LABELS };
