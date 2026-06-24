import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';
import { config } from '../../config.js';
import { safeFetchToBuffer } from '../../net/egress.js';
import { createGate } from '../../util/gate.js';
import { pacedSend } from '../../baileys/sendQueue.js';

export const messagesRouter = Router();

// Bound concurrent media work so a burst of large image/file/audio sends can't
// pile up enough multi-MB Buffers to OOM the 512 MB-capped process.
const mediaGate = createGate(config.MEDIA_CONCURRENCY, config.MEDIA_CONCURRENCY * 4);

// 20 MB hard cap on a decoded base64 media blob. Matches express.json({ limit: '20mb' })
// but applied to the *decoded* bytes — base64 inflates by ~4/3, so the JSON body itself
// has to be ≤ 27 MB to encode 20 MB of media, which is already blocked by express.json.
// This second cap exists so a 19 MB JSON body that decodes to >20 MB is still rejected.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// Recipients we accept:
//   +972501234567        — E.164 with leading +
//   972501234567         — bare digits (7-15)
//   972501234567@s.whatsapp.net
//   120363042xxxx@g.us   — group jid (long digit string)
//   <digits>@lid          — WhatsApp logical id
const RECIPIENT_RE = /^(\+?\d{7,15}|\d{7,15}@s\.whatsapp\.net|\d{15,}@g\.us|\d{1,20}@lid)$/;

function recipientField() {
  return z.string()
    .trim()
    .min(1)
    .refine((v) => RECIPIENT_RE.test(v), { message: 'invalid_recipient' });
}

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

// ─── Helpers ───────────────────────────────────────────────────────────
const baseTo = z.object({
  to: recipientField(),
});

// Base64 size estimator without allocating a Buffer first.
// Spec: every 4 base64 chars = 3 bytes; trailing '=' subtracts 1 byte each.
function base64ByteLength(b64) {
  if (typeof b64 !== 'string') return 0;
  // Strip data URL prefix if present and whitespace.
  const s = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor(s.length * 3 / 4) - padding;
}

function mediaSource(field) {
  const urlKey = `${field}Url`;
  const b64Key = `${field}Base64`;
  return z
    .object({
      [urlKey]: z.string().url().optional(),
      [b64Key]: z.string().min(1).optional(),
    })
    .refine((v) => !!(v[urlKey] || v[b64Key]), {
      message: `Either ${urlKey} or ${b64Key} is required`,
    })
    .refine(
      (v) => !v[b64Key] || base64ByteLength(v[b64Key]) <= MAX_MEDIA_BYTES,
      { message: `file_too_large — max ${MAX_MEDIA_BYTES} bytes (20 MB) decoded`, path: [b64Key] },
    );
}

// Resolve a media source to a bare in-memory Buffer the Hub controls. For URLs
// we fetch the bytes ourselves through the SSRF guard (scheme/IP-checked, size-
// capped, redirects re-validated) so Baileys never sees the raw URL — closing
// the server-side-fetch SSRF + DNS-rebinding vectors and enforcing the 20 MB cap
// on remote media too. A bare Buffer is Baileys' accepted media shape; note that
// { stream: Buffer } is NOT (Baileys would iterate the Buffer byte-by-byte and
// throw), so we must return the Buffer itself.
async function resolveMediaContent(field, body) {
  const url = body[`${field}Url`];
  if (url) {
    return safeFetchToBuffer(url, { maxBytes: MAX_MEDIA_BYTES });
  }
  // Strip data: URL prefix if the caller sent one — Buffer.from() doesn't like it.
  const raw = body[`${field}Base64`].replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(raw, 'base64');
}

// Tiny route wrapper so we don't repeat try/catch in every handler.
const wrap = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);

// ─── Routes ────────────────────────────────────────────────────────────
messagesRouter.post('/send/text', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.extend({
    text: z.string().min(1).max(4096),
    quotedMessageId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => getSocket().sendMessage(jid, { text: parsed.data.text }), { textLen: parsed.data.text.length });
  res.json({ ok: true, id: sent?.key?.id, to: jid, timestamp: Date.now() });
}));

messagesRouter.post('/send/image', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.and(mediaSource('image')).and(
    z.object({ caption: z.string().max(1024).optional() }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => mediaGate.run(async () => {
    const image = await resolveMediaContent('image', parsed.data);
    return getSocket().sendMessage(jid, { image, caption: parsed.data.caption });
  }), { textLen: (parsed.data.caption || '').length });
  res.json({ ok: true, id: sent?.key?.id, to: jid });
}));

messagesRouter.post('/send/file', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.and(mediaSource('file')).and(
    z.object({
      filename: z.string().min(1).max(255),
      mimetype: z.string().min(1).max(127).default('application/octet-stream'),
      caption: z.string().max(1024).optional(),
    }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => mediaGate.run(async () => {
    const document = await resolveMediaContent('file', parsed.data);
    return getSocket().sendMessage(jid, {
      document,
      fileName: parsed.data.filename,
      mimetype: parsed.data.mimetype,
      caption: parsed.data.caption,
    });
  }), { textLen: (parsed.data.caption || '').length });
  res.json({ ok: true, id: sent?.key?.id, to: jid });
}));

messagesRouter.post('/send/audio', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.and(mediaSource('audio')).and(
    z.object({ ptt: z.boolean().default(true) }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => mediaGate.run(async () => {
    const audio = await resolveMediaContent('audio', parsed.data);
    return getSocket().sendMessage(jid, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: parsed.data.ptt,
    });
  }), {});
  res.json({ ok: true, id: sent?.key?.id, to: jid });
}));

messagesRouter.post('/send/location', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.extend({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().max(255).optional(),
    address: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => getSocket().sendMessage(jid, {
    location: {
      degreesLatitude: parsed.data.latitude,
      degreesLongitude: parsed.data.longitude,
      name: parsed.data.name,
      address: parsed.data.address,
    },
  }), {});
  res.json({ ok: true, id: sent?.key?.id, to: jid });
}));

messagesRouter.post('/send/reaction', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.extend({
    messageId: z.string().min(1).max(255),
    emoji: z.string().min(0).max(8),
    fromMe: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  const sent = await pacedSend(jid, () => getSocket().sendMessage(jid, {
    react: {
      text: parsed.data.emoji,
      key: { remoteJid: jid, id: parsed.data.messageId, fromMe: parsed.data.fromMe },
    },
  }), { typing: false });
  res.json({ ok: true, id: sent?.key?.id });
}));

messagesRouter.post('/markRead', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.extend({
    messageId: z.string().min(1).max(255),
    fromMe: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  await getSocket().readMessages([{ remoteJid: jid, id: parsed.data.messageId, fromMe: parsed.data.fromMe }]);
  res.json({ ok: true });
}));

// Send a chatstate (typing / recording / online / offline) to a chat. No message
// is sent — useful as a "humanizer" and for live UIs. The send queue can also do
// this automatically before each message when SEND_TYPING=true.
messagesRouter.post('/presence', requireConnected, wrap(async (req, res) => {
  const schema = baseTo.extend({
    type: z.enum(['composing', 'recording', 'paused', 'available', 'unavailable']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  const jid = normalizeJid(parsed.data.to);
  await getSocket().sendPresenceUpdate(parsed.data.type, jid);
  res.json({ ok: true });
}));
