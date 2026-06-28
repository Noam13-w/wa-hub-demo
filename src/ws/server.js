import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { state } from '../state.js';
import { timingSafeStringEqual } from '../security/compare.js';

const log = logger.child({ mod: 'ws' });

function tokenMatches(provided) {
  return timingSafeStringEqual(typeof provided === 'string' ? provided : '', config.HUB_TOKEN);
}

/**
 * Pull the token from, in order: Authorization: Bearer header (preferred — does
 * not leak into URLs), then the ?token= query fallback (documented, but leaks
 * into proxy/edge logs and browser history).
 */
function extractWsToken(req, url) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return url.searchParams.get('token');
}

function originAllowed(req) {
  if (config.WS_ALLOWED_ORIGINS.length === 0) return true; // no restriction configured
  const origin = req.headers['origin'];
  if (!origin) return true; // non-browser clients don't send Origin
  return config.WS_ALLOWED_ORIGINS.includes(origin);
}

/**
 * Start a WebSocket broadcaster that pushes every Hub event in real time.
 * Binds to WS_HOST (loopback by default). Auth: Bearer header or ?token=.
 */
export function startWsServer() {
  const wss = new WebSocketServer({
    port: config.WS_PORT,
    host: config.WS_HOST,
    // Clients are receive-only; cap inbound frames so a client can't push large
    // buffers at the 512 MB-capped process.
    maxPayload: 4 * 1024,
  });
  log.info({ port: config.WS_PORT, host: config.WS_HOST }, 'WebSocket server listening');

  // A bind failure surfaces as an 'error' event; make it loud + fatal so systemd
  // restarts us rather than running with no WebSocket server.
  wss.on('error', (err) => {
    log.error({ err, port: config.WS_PORT }, 'WebSocket server failed to bind — exiting');
    process.exit(1);
  });

  wss.on('connection', (ws, req) => {
    // Per-socket error handler FIRST — before any rejection path. A rejected socket
    // (capacity/origin/token) still lingers through its ~30s close handshake, during
    // which an inbound malformed/oversized frame makes `ws` emit 'error'. With no
    // listener that becomes an uncaughtException → the whole process exits. So every
    // socket, including the ones we're about to close, must have an error listener.
    ws.on('error', (err) => log.warn({ err: err.message }, 'ws client error'));

    // Cap simultaneous clients so connection floods can't exhaust memory/FDs.
    if (wss.clients.size > config.WS_MAX_CLIENTS) {
      ws.close(1013, 'try_again_later');
      return;
    }
    if (!originAllowed(req)) {
      ws.close(4003, 'forbidden_origin');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (!tokenMatches(extractWsToken(req, url))) {
      ws.close(4001, 'unauthorized');
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    log.info({ remote: req.socket.remoteAddress }, 'ws client connected');
    ws.send(JSON.stringify({ event: 'hello', data: { connection: state.connection, me: state.me } }));
  });

  // Liveness: ping every 30s and reap any client that didn't pong since the last
  // round, so dead connections don't accumulate.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  const broadcast = (event, data) => {
    const payload = JSON.stringify({ event, timestamp: Date.now(), data });
    for (const client of wss.clients) {
      // Skip slow clients whose send buffer is backing up, so one stalled
      // consumer can't balloon server memory.
      if (client.readyState === 1 && client.bufferedAmount < 1 << 20) client.send(payload);
    }
  };

  const events = [
    'message.incoming',
    'message.outgoing',
    'message.status',
    'instance.connected',
    'instance.disconnected',
    'instance.qr',
  ];
  for (const e of events) state.on(e, (d) => broadcast(e, d));

  return wss;
}
