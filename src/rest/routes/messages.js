import { Router } from 'express';
import { z } from 'zod';
import { getSocket } from '../../baileys/socket.js';
import { normalizeJid } from '../../baileys/jid.js';
import { state } from '../../state.js';

export const messagesRouter = Router();

function requireConnected(_req, res, next) {
  if (state.connection !== 'connected' || !getSocket()) {
    return res.status(503).json({ error: 'not_connected', state: state.connection });
  }
  next();
}

// ─── Helpers ───────────────────────────────────────────────────────────
const baseTo = z.object({
  to: z.string().min(1),
});

function mediaSource(field) {
  return z
    .object({
      [`${field}Url`]: z.string().url().optional(),
      [`${field}Base64`]: z.string().min(1).optional(),
    })
    .refine((v) => !!(v[`${field}Url`] || v[`${field}Base64`]), {
      message: `Either ${field}Url or ${field}Base64 is required`,
    });
}

function toMediaContent(field, body) {
  const url = body[`${field}Url`];
  if (url) return { url };
  return { stream: Buffer.from(body[`${field}Base64`], 'base64') };
}

// ─── Routes ────────────────────────────────────────────────────────────
messagesRouter.post('/send/text', requireConnected, async (req, res, next) => {
  const schema = baseTo.extend({
    text: z.string().min(1).max(4096),
    quotedMessageId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const sent = await getSocket().sendMessage(jid, { text: parsed.data.text });
    res.json({ ok: true, id: sent?.key?.id, to: jid, timestamp: Date.now() });
  } catch (err) { next(err); }
});

messagesRouter.post('/send/image', requireConnected, async (req, res, next) => {
  const schema = baseTo.and(mediaSource('image')).and(
    z.object({ caption: z.string().max(1024).optional() }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const image = toMediaContent('image', parsed.data);
    const sent = await getSocket().sendMessage(jid, { image, caption: parsed.data.caption });
    res.json({ ok: true, id: sent?.key?.id, to: jid });
  } catch (err) { next(err); }
});

messagesRouter.post('/send/file', requireConnected, async (req, res, next) => {
  const schema = baseTo.and(mediaSource('file')).and(
    z.object({
      filename: z.string().min(1),
      mimetype: z.string().min(1).default('application/octet-stream'),
      caption: z.string().max(1024).optional(),
    }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const document = toMediaContent('file', parsed.data);
    const sent = await getSocket().sendMessage(jid, {
      document,
      fileName: parsed.data.filename,
      mimetype: parsed.data.mimetype,
      caption: parsed.data.caption,
    });
    res.json({ ok: true, id: sent?.key?.id, to: jid });
  } catch (err) { next(err); }
});

messagesRouter.post('/send/audio', requireConnected, async (req, res, next) => {
  const schema = baseTo.and(mediaSource('audio')).and(
    z.object({ ptt: z.boolean().default(true) }),
  );
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const audio = toMediaContent('audio', parsed.data);
    const sent = await getSocket().sendMessage(jid, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: parsed.data.ptt,
    });
    res.json({ ok: true, id: sent?.key?.id, to: jid });
  } catch (err) { next(err); }
});

messagesRouter.post('/send/location', requireConnected, async (req, res, next) => {
  const schema = baseTo.extend({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const sent = await getSocket().sendMessage(jid, {
      location: {
        degreesLatitude: parsed.data.latitude,
        degreesLongitude: parsed.data.longitude,
        name: parsed.data.name,
        address: parsed.data.address,
      },
    });
    res.json({ ok: true, id: sent?.key?.id, to: jid });
  } catch (err) { next(err); }
});

messagesRouter.post('/send/reaction', requireConnected, async (req, res, next) => {
  const schema = baseTo.extend({
    messageId: z.string().min(1),
    emoji: z.string().min(0).max(8),
    fromMe: z.boolean().default(false),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });

  try {
    const jid = normalizeJid(parsed.data.to);
    const sent = await getSocket().sendMessage(jid, {
      react: {
        text: parsed.data.emoji,
        key: { remoteJid: jid, id: parsed.data.messageId, fromMe: parsed.data.fromMe },
      },
    });
    res.json({ ok: true, id: sent?.key?.id });
  } catch (err) { next(err); }
});

messagesRouter.post('/markRead', requireConnected, async (req, res, next) => {
  const schema = baseTo.extend({ messageId: z.string().min(1), fromMe: z.boolean().default(false) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
  try {
    const jid = normalizeJid(parsed.data.to);
    await getSocket().readMessages([{ remoteJid: jid, id: parsed.data.messageId, fromMe: parsed.data.fromMe }]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
