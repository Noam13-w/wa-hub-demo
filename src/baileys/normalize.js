import { bareNumber, extractPhone, isGroup, isLid } from './jid.js';

/**
 * Convert a raw Baileys `IMessage` into a clean, stable JSON shape
 * that API consumers (Base44, etc.) can rely on without learning
 * the Baileys protocol internals.
 *
 * Note on Baileys 7+ / WhatsApp LID: many JIDs are now `@lid` (logical id)
 * rather than phone numbers. We expose BOTH:
 *   - `from`       — the raw JID (may be @lid or @s.whatsapp.net)
 *   - `fromNumber` — the best-effort phone number, resolved from senderPn
 *                    or remoteJidAlt when available. May still be a LID
 *                    digit string if no phone is exposed by the message.
 *   - `fromLid`    — true when the JID was @lid
 */
export function normalizeMessage(raw) {
  if (!raw?.key) return null;
  const remote = raw.key.remoteJid;
  const fromMe = !!raw.key.fromMe;
  const participant = raw.key.participant || (fromMe ? raw.key.remoteJid : remote);

  const m = raw.message || {};
  const contentType = pickContentType(m);
  const { text, media } = extractContent(m, contentType);

  return {
    id: raw.key.id,
    timestamp: toMillis(raw.messageTimestamp),
    chat: remote,
    chatAlt: raw.key.remoteJidAlt || null,
    isGroup: isGroup(remote),
    from: participant,
    fromMe,
    fromNumber: extractPhone(raw, participant),
    fromLid: isLid(participant),
    fromName: raw.pushName || null,
    type: contentType,
    text,
    media,
    quoted: extractQuoted(m),
    raw: undefined, // dropped on purpose — keep payload small. Set DEBUG_RAW=1 to include in dev.
  };
}

// Baileys `messageTimestamp` may arrive as a number, a Long ({ toNumber() }),
// or a numeric string. Normalize all of them to epoch milliseconds; only fall
// back to "now" when the field is genuinely absent.
function toMillis(ts) {
  if (typeof ts === 'number') return ts * 1000;
  if (ts && typeof ts.toNumber === 'function') return ts.toNumber() * 1000;
  if (typeof ts === 'string' && /^\d+$/.test(ts)) return Number(ts) * 1000;
  return Date.now();
}

function pickContentType(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.audioMessage) return 'audio';
  if (message.documentMessage || message.documentWithCaptionMessage) return 'document';
  if (message.stickerMessage) return 'sticker';
  if (message.locationMessage) return 'location';
  if (message.contactMessage || message.contactsArrayMessage) return 'contact';
  if (message.reactionMessage) return 'reaction';
  if (message.pollCreationMessageV3 || message.pollCreationMessage) return 'poll';
  return 'unknown';
}

function extractContent(message, type) {
  switch (type) {
    case 'text':
      return {
        text: message.conversation || message.extendedTextMessage?.text || '',
        media: null,
      };
    case 'image':
    case 'video':
    case 'audio':
    case 'sticker': {
      const inner = message[`${type}Message`];
      return {
        text: inner?.caption || '',
        media: {
          kind: type,
          mimetype: inner?.mimetype,
          fileLength: inner?.fileLength,
          width: inner?.width,
          height: inner?.height,
          seconds: inner?.seconds,
          ptt: inner?.ptt,
        },
      };
    }
    case 'document': {
      const inner = message.documentMessage || message.documentWithCaptionMessage?.message?.documentMessage;
      return {
        text: inner?.caption || '',
        media: {
          kind: 'document',
          mimetype: inner?.mimetype,
          fileName: inner?.fileName,
          fileLength: inner?.fileLength,
        },
      };
    }
    case 'location': {
      const loc = message.locationMessage;
      return {
        text: loc?.name || loc?.address || '',
        media: { kind: 'location', latitude: loc?.degreesLatitude, longitude: loc?.degreesLongitude },
      };
    }
    case 'reaction': {
      const r = message.reactionMessage;
      return { text: r?.text || '', media: { kind: 'reaction', targetMessageId: r?.key?.id } };
    }
    default:
      return { text: '', media: null };
  }
}

function extractQuoted(message) {
  const ctx = message.extendedTextMessage?.contextInfo;
  if (!ctx?.stanzaId) return null;
  return {
    id: ctx.stanzaId,
    from: ctx.participant || null,
  };
}
