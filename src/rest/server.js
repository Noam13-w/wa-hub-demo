import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { apiRateLimit, healthRateLimit, requireAuth } from '../auth.js';
import { state } from '../state.js';
import { recordError } from '../diagnostics.js';
import { pairPageHtml } from './pairPage.js';
import { instanceRouter } from './routes/instance.js';
import { messagesRouter } from './routes/messages.js';
import { groupsRouter } from './routes/groups.js';
import { checkRouter } from './routes/check.js';

const log = logger.child({ mod: 'rest' });

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
  // Deliberately minimal: an unauthenticated liveness probe for uptime monitors.
  // Version, instance name, queue depths, error counts and uptime are recon
  // signals (CWE-200) and now live behind the token at GET /api/instance/status
  // and /api/instance/diagnose. Rate-limited so it can't be flooded.
  app.get('/healthz', healthRateLimit, (_req, res) => {
    res.setHeader('content-security-policy', STRICT_CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    res.json({ ok: true, connection: state.connection });
  });

  // Public live-pairing page. Carries no secret — the browser supplies the
  // token (pasted, or via the URL #fragment which is never sent to the server)
  // and polls the token-gated /api/instance/* endpoints itself. A per-request
  // nonce keeps the inline script/style strict (no 'unsafe-inline').
  app.get('/pair', healthRateLimit, (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'content-security-policy',
      `default-src 'none'; img-src 'self' data:; style-src 'nonce-${nonce}'; ` +
        `script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; ` +
        `form-action 'none'; frame-ancestors 'none'`,
    );
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    res.type('html').send(pairPageHtml(nonce));
  });

  // Bare root → the pairing/console page, so opening the tunnel URL in a browser
  // "just works" instead of returning a bare 404 JSON. /pair carries no secret.
  app.get('/', (_req, res) => res.redirect(302, '/pair'));

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
    // Typed, client-safe errors carry an explicit status + code (egress policy
    // rejections → 400, load-shed → 503). Surface those verbatim.
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.code || 'bad_request', message: err.message });
    }
    if (err?.status === 503) {
      return res.status(503).json({ error: err.code || 'unavailable', message: 'Server busy, retry shortly' });
    }
    // Genuine 500s: keep the detail in the logs/ring buffer (above), return a
    // generic body so internal messages/paths don't leak to the caller.
    res.status(500).json({ error: 'internal', message: 'unexpected server error' });
  });

  return app;
}
