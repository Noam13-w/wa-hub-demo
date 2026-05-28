import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';

export const groupsRouter = Router();

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

groupsRouter.get('/', requireConnected, async (_req, res, next) => {
  try {
    const groups = await getSocket().groupFetchAllParticipating();
    const list = Object.values(groups).map((g) => ({
      jid: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
      owner: g.owner || null,
      creation: g.creation ? g.creation * 1000 : null,
      announce: !!g.announce,
    }));
    res.json({ count: list.length, groups: list });
  } catch (err) { next(err); }
});

groupsRouter.get('/:jid', requireConnected, async (req, res, next) => {
  try {
    const jid = normalizeJid(req.params.jid);
    const meta = await getSocket().groupMetadata(jid);
    res.json(meta);
  } catch (err) { next(err); }
});

const participantsAction = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  promote: z.array(z.string()).optional(),
  demote: z.array(z.string()).optional(),
});

groupsRouter.post('/:jid/participants', requireConnected, async (req, res, next) => {
  const parsed = participantsAction.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    const jid = normalizeJid(req.params.jid);
    const sock = getSocket();
    const results = {};
    for (const action of ['add', 'remove', 'promote', 'demote']) {
      const list = parsed.data[action];
      if (!list?.length) continue;
      const jids = list.map(normalizeJid);
      results[action] = await sock.groupParticipantsUpdate(jid, jids, action);
    }
    res.json({ ok: true, results });
  } catch (err) { next(err); }
});
