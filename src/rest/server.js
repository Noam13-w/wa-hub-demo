import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { apiRateLimit, requireAuth } from '../auth.js';
import { state } from '../state.js';
import { instanceRouter } from './routes/instance.js';
import { messagesRouter } from './routes/messages.js';
import { groupsRouter } from './routes/groups.js';
import { checkRouter } from './routes/check.js';

const log = logger.child({ mod: 'rest' });

export function buildApp() {
  const app = express();

  // Body parser — we accept up to 20MB to allow base64-encoded media.
  app.use(express.json({ limit: '20mb' }));
  app.disable('x-powered-by');

  // Request logging (terse).
  app.use((req, _res, next) => {
    if (req.path !== '/healthz') log.debug({ m: req.method, p: req.path }, 'req');
    next();
  });

  // Open endpoints.
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      name: config.HUB_NAME,
      connection: state.connection,
      uptimeMs: Date.now() - state.startedAt,
    });
  });

  // Everything under /api requires Bearer token + rate limit.
  const api = express.Router();
  api.use(requireAuth);
  api.use(apiRateLimit);
  api.use('/instance', instanceRouter);
  api.use('/messages', messagesRouter);
  api.use('/groups', groupsRouter);
  api.use('/check', checkRouter);
  app.use('/api', api);

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Error handler.
  app.use((err, _req, res, _next) => {
    log.error({ err: err.message, stack: err.stack }, 'unhandled error');
    res.status(500).json({ error: 'internal', message: err.message });
  });

  return app;
}
