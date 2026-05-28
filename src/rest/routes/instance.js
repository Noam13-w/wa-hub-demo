import { Router } from 'express';
import { z } from 'zod';
import { state } from '../../state.js';
import { resetAuth } from '../../baileys/socket.js';
import { config } from '../../config.js';

export const instanceRouter = Router();

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
  if (!state.qr) {
    return res.status(404).json({ error: 'no_qr', message: 'No QR available yet. Wait a moment and retry.' });
  }
  res.json(state.qr);
});

// Convenience: render the QR as an actual PNG so you can open it in a browser.
instanceRouter.get('/qr.png', (_req, res) => {
  if (!state.qr) return res.status(404).end();
  const b64 = state.qr.dataUrl.replace(/^data:image\/png;base64,/, '');
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'no-store');
  res.end(Buffer.from(b64, 'base64'));
});

const webhookSchema = z.object({
  url: z.string().url().nullable().optional(),
  events: z.array(z.string()).optional(),
});

instanceRouter.get('/webhook', (_req, res) => {
  res.json(state.webhook);
});

instanceRouter.put('/webhook', (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  }
  state.setWebhook({ url: parsed.data.url ?? null, events: parsed.data.events ?? [] });
  res.json(state.webhook);
});

instanceRouter.post('/logout', async (_req, res, next) => {
  try {
    await resetAuth();
    res.json({ ok: true, message: 'Auth cleared. New QR will appear shortly at GET /api/instance/qr' });
  } catch (err) {
    next(err);
  }
});
