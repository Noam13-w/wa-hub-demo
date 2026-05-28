import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';

export const checkRouter = Router();

// A check input is a phone in one of the recipient formats we accept elsewhere.
const RECIPIENT_RE = /^(\+?\d{7,15}|\d{7,15}@s\.whatsapp\.net|\d{1,20}@lid)$/;

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

const wrap = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);

/**
 * POST /api/check/number  { numbers: ["972501234567", ...] }
 * Returns which of the provided numbers are registered on WhatsApp.
 * Useful before sending to verify the recipient exists.
 */
checkRouter.post('/number', requireConnected, wrap(async (req, res) => {
  const schema = z.object({
    numbers: z
      .array(z.string().refine((v) => RECIPIENT_RE.test(v.trim()), { message: 'invalid_recipient' }))
      .min(1)
      .max(50),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const sock = getSocket();
  const results = await Promise.all(
    parsed.data.numbers.map(async (n) => {
      const jid = normalizeJid(n);
      const [info] = (await sock.onWhatsApp(jid)) || [];
      return { input: n, exists: !!info?.exists, jid: info?.jid || null };
    }),
  );
  res.json({ results });
}));
