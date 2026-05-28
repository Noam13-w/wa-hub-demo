import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';

export const groupsRouter = Router();

// A group JID is always a long digit string @g.us.
const GROUP_JID_RE = /^\d{15,}@g\.us$/;
// A participant is a phone or @s.whatsapp.net or @lid.
const PARTICIPANT_RE = /^(\+?\d{7,15}|\d{7,15}@s\.whatsapp\.net|\d{1,20}@lid)$/;

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

function validGroupJid(input) {
  // Accept either the raw 15+ digit group id, or the full @g.us form.
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (GROUP_JID_RE.test(trimmed)) return true;
  if (/^\d{15,}$/.test(trimmed)) return true; // bare → normalizeJid will add @g.us? No, it adds @s.whatsapp.net.
  return false;
}

const wrap = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);

groupsRouter.get('/', requireConnected, wrap(async (_req, res) => {
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
}));

groupsRouter.get('/:jid', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) {
    return res.status(400).json({ error: 'invalid_group_jid', message: 'Expected a 15+ digit group id, optionally suffixed with @g.us' });
  }
  // groupMetadata wants the full @g.us form. normalizeJid would turn a bare digit
  // string into @s.whatsapp.net, so handle the group case explicitly.
  const raw = req.params.jid.trim();
  const jid = raw.includes('@') ? raw : `${raw}@g.us`;
  const meta = await getSocket().groupMetadata(jid);
  res.json(meta);
}));

const participantsAction = z.object({
  add: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).max(50).optional(),
  remove: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).max(50).optional(),
  promote: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).max(50).optional(),
  demote: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).max(50).optional(),
});

groupsRouter.post('/:jid/participants', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) {
    return res.status(400).json({ error: 'invalid_group_jid' });
  }
  const parsed = participantsAction.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const raw = req.params.jid.trim();
  const jid = raw.includes('@') ? raw : `${raw}@g.us`;
  const sock = getSocket();
  const results = {};
  for (const action of ['add', 'remove', 'promote', 'demote']) {
    const list = parsed.data[action];
    if (!list?.length) continue;
    const jids = list.map(normalizeJid);
    results[action] = await sock.groupParticipantsUpdate(jid, jids, action);
  }
  res.json({ ok: true, results });
}));
