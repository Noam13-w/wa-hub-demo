import { Router } from 'express';
import { z } from 'zod';
import { state } from '../../state.js';
import { getSocket, resetAuth } from '../../baileys/socket.js';
import { config } from '../../config.js';
import { requireAdmin } from '../../auth.js';
import { assertSafeUrl, EgressError } from '../../net/egress.js';
import {
  getErrors,
  getWebhookFailures,
  runDiagnose,
} from '../../diagnostics.js';

export const instanceRouter = Router();

// Same strict CSP we apply to /healthz — anyone may open these in a tab.
const STRICT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

instanceRouter.get('/status', (_req, res) => {
  res.json({
    name: config.HUB_NAME,
    connection: state.connection,
    me: state.me,
    startedAt: state.startedAt,
    uptimeMs: Date.now() - state.startedAt,
    lastEventAt: state.lastEventAt,
    webhook: { url: state.webhook.url, events: state.webhook.events },
  });
});

instanceRouter.get('/qr', (_req, res) => {
  if (state.connection === 'connected') {
    return res.status(409).json({ error: 'already_paired', me: state.me });
  }
  if (!state.qr || (state.qr.expiresAt && state.qr.expiresAt < Date.now())) {
    return res.status(404).json({ error: 'no_qr', message: 'No fresh QR available yet. Wait a moment and retry.' });
  }
  res.json(state.qr);
});

// Convenience: render the QR as an actual PNG so you can open it in a browser.
instanceRouter.get('/qr.png', (_req, res) => {
  if (!state.qr || (state.qr.expiresAt && state.qr.expiresAt < Date.now())) return res.status(404).end();
  const b64 = state.qr.dataUrl.replace(/^data:image\/png;base64,/, '');
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', STRICT_CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(Buffer.from(b64, 'base64'));
});

const webhookSchema = z.object({
  url: z.string().url().nullable().optional(),
  events: z.array(z.string()).optional(),
});

instanceRouter.get('/webhook', (_req, res) => {
  res.json(state.webhook);
});

instanceRouter.put('/webhook', requireAdmin, (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  // Enforce the same egress policy as config-time: http(s) only, and (unless
  // ALLOW_PRIVATE_EGRESS) reject literal private/reserved targets. This blocks
  // the obvious SSRF set; DNS-rebinding is caught later by the connect guard.
  const url = parsed.data.url ?? null;
  if (url) {
    try {
      assertSafeUrl(url);
    } catch (err) {
      const code = err instanceof EgressError ? err.code : 'invalid_url';
      return res.status(400).json({ error: code, message: err.message });
    }
  }
  state.setWebhook({ url, events: parsed.data.events ?? [] });
  res.json(state.webhook);
});

// Last N webhook delivery failures (disk-backed, capped at 100).
instanceRouter.get('/webhook/failures', (_req, res) => {
  res.json({ count: getWebhookFailures().length, failures: getWebhookFailures() });
});

// Last N route / unhandled errors (in-memory, capped at 50). The full stack is
// kept server-side (logs) but NOT echoed over the API — stacks disclose absolute
// host paths and internal structure (CWE-209).
instanceRouter.get('/errors', (_req, res) => {
  const sanitized = getErrors().map(({ timestamp, name, message, ctx }) => ({ timestamp, name, message, ctx }));
  res.json({ count: sanitized.length, errors: sanitized });
});

// Hub self-test — runs a small battery of checks and returns a structured JSON.
// Total wall-clock ~6s worst-case (the public-internet probe).
instanceRouter.get('/diagnose', async (_req, res, next) => {
  try {
    const sock = getSocket();
    const result = await runDiagnose({
      socketOpen: !!sock && state.connection === 'connected',
      webhookConfigured: !!state.webhook.url,
      connection: state.connection,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

instanceRouter.post('/logout', requireAdmin, async (_req, res, next) => {
  try {
    await resetAuth();
    res.json({ ok: true, message: 'Auth cleared. New QR will appear shortly at GET /api/instance/qr' });
  } catch (err) {
    next(err);
  }
});
