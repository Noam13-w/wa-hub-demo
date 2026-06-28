import { Router } from 'express';
import { z } from 'zod';
import { getSocket, currentSock } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';
import { pacedRun } from '../../baileys/sendQueue.js';

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
  const groups = await currentSock().groupFetchAllParticipating();
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
  const meta = await currentSock().groupMetadata(jid);
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
  const results = {};
  for (const action of ['add', 'remove', 'promote', 'demote']) {
    const list = parsed.data[action];
    if (!list?.length) continue;
    const jids = list.map(normalizeJid);
    // Each participant mutation is ban-sensitive — funnel through the FIFO pacer.
    results[action] = await pacedRun(() => currentSock().groupParticipantsUpdate(jid, jids, action));
  }
  res.json({ ok: true, results });
}));

// ─── Group lifecycle & admin ─────────────────────────────────────────────
const INVITE_BASE = 'https://chat.whatsapp.com/';
const toGroupJid = (raw) => { const t = String(raw).trim(); return t.includes('@') ? t : `${t}@g.us`; };
const stripInvite = (c) => String(c).trim().replace(/^https?:\/\/chat\.whatsapp\.com\//, '');

// Create a group. ⚠ Bulk-creating groups or adding strangers is a top ban signal —
// use only with consenting participants (see docs/INTEGRATION.md → Anti-ban).
groupsRouter.post('/', requireConnected, wrap(async (req, res) => {
  const parsed = z.object({
    subject: z.string().trim().min(1).max(100),
    participants: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).max(50).default([]),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const meta = await pacedRun(() => currentSock().groupCreate(parsed.data.subject, parsed.data.participants.map(normalizeJid)));
  res.json({ ok: true, jid: meta.id, subject: meta.subject, participants: meta.participants?.length ?? 0 });
}));

groupsRouter.post('/:jid/leave', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  await pacedRun(() => currentSock().groupLeave(toGroupJid(req.params.jid)));
  res.json({ ok: true });
}));

groupsRouter.put('/:jid/subject', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ subject: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupUpdateSubject(toGroupJid(req.params.jid), parsed.data.subject));
  res.json({ ok: true });
}));

// Empty/omitted description clears it.
groupsRouter.put('/:jid/description', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ description: z.string().max(2048).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupUpdateDescription(toGroupJid(req.params.jid), parsed.data.description));
  res.json({ ok: true });
}));

// announcement = only admins can post; locked = only admins can edit group info.
groupsRouter.put('/:jid/settings', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupSettingUpdate(toGroupJid(req.params.jid), parsed.data.setting));
  res.json({ ok: true });
}));

// Disappearing messages: 0 off, 86400 (24h), 604800 (7d), 7776000 (90d).
groupsRouter.put('/:jid/ephemeral', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ seconds: z.coerce.number().int().nonnegative() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupToggleEphemeral(toGroupJid(req.params.jid), parsed.data.seconds));
  res.json({ ok: true });
}));

groupsRouter.put('/:jid/member-add-mode', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ mode: z.enum(['admin_add', 'all_member_add']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupMemberAddMode(toGroupJid(req.params.jid), parsed.data.mode));
  res.json({ ok: true });
}));

groupsRouter.put('/:jid/join-approval', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({ mode: z.enum(['on', 'off']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  await pacedRun(() => currentSock().groupJoinApprovalMode(toGroupJid(req.params.jid), parsed.data.mode));
  res.json({ ok: true });
}));

// Invite link (admin only). The reliable way to bring people in when their privacy
// blocks a direct add — send them this link via /api/messages/send/text.
groupsRouter.get('/:jid/invite', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const code = await currentSock().groupInviteCode(toGroupJid(req.params.jid));
  res.json({ ok: true, code, url: code ? INVITE_BASE + code : null });
}));

groupsRouter.post('/:jid/invite/revoke', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const code = await pacedRun(() => currentSock().groupRevokeInvite(toGroupJid(req.params.jid)));
  res.json({ ok: true, code, url: code ? INVITE_BASE + code : null });
}));

// Pending join requests (admin only).
groupsRouter.get('/:jid/requests', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const list = await currentSock().groupRequestParticipantsList(toGroupJid(req.params.jid));
  res.json({ ok: true, requests: list || [] });
}));

groupsRouter.post('/:jid/requests', requireConnected, wrap(async (req, res) => {
  if (!validGroupJid(req.params.jid)) return res.status(400).json({ error: 'invalid_group_jid' });
  const parsed = z.object({
    participants: z.array(z.string().refine((v) => PARTICIPANT_RE.test(v), { message: 'invalid_participant' })).min(1).max(50),
    action: z.enum(['approve', 'reject']),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const results = await pacedRun(() => currentSock().groupRequestParticipantsUpdate(toGroupJid(req.params.jid), parsed.data.participants.map(normalizeJid), parsed.data.action));
  res.json({ ok: true, results });
}));

// Preview a group from an invite code (no join). `code` = the part after chat.whatsapp.com/
groupsRouter.get('/invite/:code', requireConnected, wrap(async (req, res) => {
  const code = stripInvite(req.params.code);
  if (!/^[A-Za-z0-9_-]{6,}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  const meta = await currentSock().groupGetInviteInfo(code);
  res.json(meta);
}));

// Join a group via invite code/link. ⚠ Mass-joining is a spam signal — use sparingly.
groupsRouter.post('/join', requireConnected, wrap(async (req, res) => {
  const parsed = z.object({ code: z.string().trim().min(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  const jid = await pacedRun(() => currentSock().groupAcceptInvite(stripInvite(parsed.data.code)));
  res.json({ ok: true, jid });
}));
