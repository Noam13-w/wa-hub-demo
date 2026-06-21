import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { apiRateLimit, requireAuth } from '../auth.js';
import { state } from '../state.js';
import { recordError } from '../diagnostics.js';
import { instanceRouter } from './routes/instance.js';
import { messagesRouter } from './routes/messages.js';
import { groupsRouter } from './routes/groups.js';
import { checkRouter } from './routes/check.js';

const log = logger.child({ mod: 'rest' });

// Resolve package.json for version reporting in /healthz.
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

// Tight CSP for the two endpoints that may be opened in a browser tab.
// /healthz is JSON; /api/instance/qr.png is an image. Neither should ever
// execute scripts, frame anything, or load remote resources.
const STRICT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function buildApp() {
  const app = express();

  // Behind a reverse proxy / tunnel, trust the FIRST hop's X-Forwarded-* so the
  // rate limiter keys on the real client IP. Opt-in via TRUST_PROXY (off by
  // default). We use `1` (single trusted proxy) rather than `true`, which would
  // trust every hop and let clients spoof IPs to bypass the limiter.
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  // Body parser — we accept up to 20MB to allow base64-encoded media.
  // (Per-route validators ALSO check the decoded base64 length so we reject
  //  oversized media with a clear `error: "file_too_large"` JSON response
  //  rather than the Express default HTML.)
  app.use(express.json({ limit: '20mb' }));
  app.disable('x-powered-by');

  // Structured per-request access log (method, path, status, ms). Skips /healthz to keep journal clean.
  // NOTE: we deliberately do NOT log headers or bodies — auth tokens and webhook payloads can contain
  // user content we don't want in logs.
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const start = Date.now();
    res.on('finish', () => {
      log.info(
        { m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - start },
        'req',
      );
    });
    next();
  });

  // ── Open endpoints ────────────────────────────────────────────────────
  app.get('/healthz', async (_req, res) => {
    res.setHeader('content-security-policy', STRICT_CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    // Lazy-import to avoid a cycle (diagnostics imports config/logger).
    const { getPending, getErrors, getWebhookFailures } = await import('../diagnostics.js');
    res.json({
      ok: true,
      name: config.HUB_NAME,
      version: PKG_VERSION,
      connection: state.connection,
      qr: !!state.qr,
      webhookConfigured: !!state.webhook.url,
      pendingDeliveries: getPending(),
      recentErrors: getErrors().length,
      recentWebhookFailures: getWebhookFailures().length,
      uptimeMs: Date.now() - state.startedAt,
    });
  });

  // ── Authenticated API ─────────────────────────────────────────────────
  const api = express.Router();
  // Rate-limit BEFORE auth so brute-force attempts against the token are
  // throttled too — not just successfully-authenticated requests.
  api.use(apiRateLimit);
  api.use(requireAuth);
  api.use('/instance', instanceRouter);
  api.use('/messages', messagesRouter);
  api.use('/groups', groupsRouter);
  api.use('/check', checkRouter);
  app.use('/api', api);

  // 404 — always JSON, never HTML.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  // Last-resort error handler. ALWAYS returns JSON (never the default HTML
  // 500 page) and records the error in the in-memory ring buffer so it can
  // be retrieved via GET /api/instance/errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    recordError(err, { method: req.method, path: req.path });
    log.error({ err: err.message, stack: err.stack, p: req.path }, 'unhandled error');
    if (res.headersSent) return;
    // Express's bodyParser JSON-too-large surfaces here with type 'entity.too.large'.
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds 20 MB limit' });
    }
    // Malformed JSON body is a client error (400), not a server error (500).
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    res.status(500).json({ error: 'internal', message: err.message || 'unexpected server error' });
  });

  return app;
}
