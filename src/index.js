import { config } from './config.js';
import { logger } from './logger.js';
import { state } from './state.js';
import { startSocket } from './baileys/socket.js';
import { attachWebhookListeners } from './webhook.js';
import { buildApp } from './rest/server.js';
import { startWsServer } from './ws/server.js';

const log = logger.child({ mod: 'main' });

async function main() {
  log.info({ name: config.HUB_NAME, restPort: config.HUB_PORT, wsPort: config.WS_PORT }, 'starting wa-hub-demo');

  // 1. Initialize webhook initial config from env (can be overridden at runtime).
  state.setWebhook({ url: config.WEBHOOK_URL ?? null, events: config.WEBHOOK_EVENTS });
  attachWebhookListeners();

  // 2. Start REST.
  const app = buildApp();
  app.listen(config.HUB_PORT, '0.0.0.0', () => {
    log.info({ port: config.HUB_PORT }, 'REST API listening');
  });

  // 3. Start WebSocket.
  startWsServer();

  // 4. Boot Baileys (asynchronously — REST is up while QR is being generated).
  startSocket().catch((err) => {
    log.error({ err }, 'failed to start Baileys socket');
    process.exit(1);
  });
}

process.on('unhandledRejection', (err) => log.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => log.error({ err }, 'uncaughtException'));

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
