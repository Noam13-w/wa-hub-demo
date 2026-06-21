import { config } from './config.js';
import { logger } from './logger.js';
import { state, loadPersistedWebhook } from './state.js';
import { startSocket, closeSocket } from './baileys/socket.js';
import { attachWebhookListeners } from './webhook.js';
import { buildApp } from './rest/server.js';
import { startWsServer } from './ws/server.js';
import { getPending, recordError } from './diagnostics.js';

const log = logger.child({ mod: 'main' });

// Heartbeat tick — 5 minutes. Reports RSS so the user can spot a leak in
// `journalctl -u wa-hub`. systemd hard-caps MemoryMax=512M so we also log
// a WARN when we cross 80% of that to give the user a heads-up before OOM-kill.
const HEARTBEAT_MS = 5 * 60 * 1000;
const MEM_WARN_BYTES = Math.floor(0.8 * 512 * 1024 * 1024);

function logMemUsage(level = 'info') {
  const mu = process.memoryUsage();
  const fmt = (b) => `${Math.round(b / 1024 / 1024)}MB`;
  log[level](
    {
      rss: fmt(mu.rss),
      heapUsed: fmt(mu.heapUsed),
      heapTotal: fmt(mu.heapTotal),
      external: fmt(mu.external),
      pendingDeliveries: getPending(),
      connection: state.connection,
    },
    'heartbeat',
  );
  if (mu.rss > MEM_WARN_BYTES) {
    log.warn(
      { rssMB: Math.round(mu.rss / 1024 / 1024), limitMB: 512 },
      'memory usage exceeds 80% of systemd MemoryMax — consider restarting or raising the cap',
    );
  }
}

async function main() {
  log.info({ name: config.HUB_NAME, restPort: config.HUB_PORT, wsPort: config.WS_PORT }, 'starting wa-hub-demo');

  // 1. Initialize webhook config.
  //    Precedence: persisted file (set at runtime via PUT /webhook) > env (.env defaults).
  //    Don't re-persist when loading from disk — would be a noop write.
  const persisted = loadPersistedWebhook();
  if (persisted && (persisted.url || persisted.events.length)) {
    state.setWebhook(persisted, { persist: false });
    log.info({ url: persisted.url, events: persisted.events.length }, 'webhook config loaded from disk');
  } else {
    state.setWebhook({ url: config.WEBHOOK_URL ?? null, events: config.WEBHOOK_EVENTS }, { persist: false });
  }
  attachWebhookListeners();

  // 2. Start REST.
  const app = buildApp();
  const httpServer = app.listen(config.HUB_PORT, config.HUB_HOST, () => {
    log.info({ port: config.HUB_PORT, host: config.HUB_HOST }, 'REST API listening');
  });
  // A bind failure (EADDRINUSE/EACCES) is emitted asynchronously as an 'error'
  // event — main()'s trailing .catch cannot see it — so handle it explicitly
  // and exit loudly (systemd Restart=always brings us back cleanly).
  httpServer.on('error', (err) => {
    recordError(err, { source: 'http_listen' });
    log.error({ err, port: config.HUB_PORT }, 'REST server failed to bind — exiting');
    process.exit(1);
  });

  // 3. Start WebSocket.
  const wss = startWsServer();

  // 4. Boot Baileys (asynchronously — REST is up while QR is being generated).
  startSocket().catch((err) => {
    log.error({ err }, 'failed to start Baileys socket');
    process.exit(1);
  });

  // 5. Heartbeat — log memory usage every 5 minutes so leaks become visible.
  logMemUsage('info'); // one immediate sample
  const heartbeat = setInterval(() => logMemUsage('info'), HEARTBEAT_MS);
  heartbeat.unref(); // never block shutdown waiting for the next tick

  // 6. Graceful shutdown — give in-flight requests up to 12s, then force-exit.
  //    Note: deploy/wa-hub.service sets TimeoutStopSec=15 so we have headroom.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const pending = getPending();
    log.info({ signal, pendingDeliveries: pending }, 'shutdown signal received — closing gracefully');
    clearInterval(heartbeat);

    const forceExit = setTimeout(() => {
      log.warn({ pendingDeliveries: getPending() }, 'graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 12_000);
    forceExit.unref();

    try {
      await Promise.allSettled([
        new Promise((resolve) => httpServer.close(() => resolve())),
        new Promise((resolve) => {
          for (const client of wss.clients) {
            try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
          }
          wss.close(() => resolve());
        }),
        closeSocket(),
      ]);

      // Webhook deliveries are fire-and-forget outbound requests that the closes
      // above do NOT await. Give any in-flight ones a bounded chance to finish
      // (stays under the 12s forceExit and systemd's TimeoutStopSec=15).
      const drainDeadline = Date.now() + 11_000;
      while (getPending() > 0 && Date.now() < drainDeadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      log.info({ drainedPending: pending - getPending(), stillPending: getPending() }, 'shutting down — drained pending deliveries');
      log.info('clean exit');
      process.exit(0);
    } catch (err) {
      log.error({ err: err.message }, 'shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  recordError(err, { source: 'unhandledRejection' });
  log.error({ err }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  recordError(err, { source: 'uncaughtException' });
  log.error({ err }, 'uncaughtException — exiting (systemd will restart)');
  // An uncaught exception leaves the process in an undefined state; exit so
  // systemd restarts a clean instance instead of limping along half-broken.
  process.exit(1);
});

main().catch((err) => {
  recordError(err, { source: 'fatal_startup' });
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
