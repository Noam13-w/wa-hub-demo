import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';

export const checkRouter = Router();

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

/**
 * POST /api/check/number  { numbers: ["972501234567", ...] }
 * Returns which of the provided numbers are registered on WhatsApp.
 * Useful before sending to verify the recipient exists.
 */
checkRouter.post('/number', requireConnected, async (req, res, next) => {
  const schema = z.object({ numbers: z.array(z.string()).min(1).max(50) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    const sock = getSocket();
    const results = await Promise.all(
      parsed.data.numbers.map(async (n) => {
        const jid = normalizeJid(n);
        const [info] = (await sock.onWhatsApp(jid)) || [];
        return { input: n, exists: !!info?.exists, jid: info?.jid || null };
      }),
    );
    res.json({ results });
  } catch (err) { next(err); }
});
