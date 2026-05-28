import { config } from './config.js';
import { logger } from './logger.js';
import { state, loadPersistedWebhook } from './state.js';
import { startSocket, closeSocket } from './baileys/socket.js';
import { attachWebhookListeners } from './webhook.js';
import { buildApp } from './rest/server.js';
import { startWsServer } from './ws/server.js';

const log = logger.child({ mod: 'main' });

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
  const httpServer = app.listen(config.HUB_PORT, '0.0.0.0', () => {
    log.info({ port: config.HUB_PORT }, 'REST API listening');
  });

  // 3. Start WebSocket.
  const wss = startWsServer();

  // 4. Boot Baileys (asynchronously — REST is up while QR is being generated).
  startSocket().catch((err) => {
    log.error({ err }, 'failed to start Baileys socket');
    process.exit(1);
  });

  // 5. Graceful shutdown — give in-flight requests up to 8s, then force-exit.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown signal received — closing gracefully');
    const forceExit = setTimeout(() => {
      log.warn('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 8000);
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

process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => log.error({ err }, 'uncaughtException'));

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
