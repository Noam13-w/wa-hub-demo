import { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { state } from '../state.js';

const log = logger.child({ mod: 'ws' });

function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.HUB_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Start a WebSocket broadcaster that pushes every Hub event in real time.
 * Auth: client sends ?token=... in the URL (Bearer over WS isn't standard).
 */
export function startWsServer() {
  const wss = new WebSocketServer({ port: config.WS_PORT, host: '0.0.0.0' });
  log.info({ port: config.WS_PORT }, 'WebSocket server listening');

  // A bind failure surfaces as an 'error' event; make it loud + fatal so systemd
  // restarts us rather than running with no WebSocket server.
  wss.on('error', (err) => {
    log.error({ err, port: config.WS_PORT }, 'WebSocket server failed to bind — exiting');
    process.exit(1);
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!tokenMatches(token)) {
      ws.close(4001, 'unauthorized');
      return;
    }
    // Per-socket error handler so a client reset can't crash the whole process.
    ws.on('error', (err) => log.warn({ err: err.message }, 'ws client error'));
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
      if (client.readyState === 1) client.send(payload);
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
