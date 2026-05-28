/**
 * JID normalization. Accepts:
 *   - "+972501234567"      → "972501234567@s.whatsapp.net"
 *   - "972501234567"       → "972501234567@s.whatsapp.net"
 *   - "972501234567@s.whatsapp.net" → unchanged
 *   - "120363042..@g.us"    → unchanged (group)
 */
export function normalizeJid(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('JID must be a non-empty string');
  }
  const v = input.trim();
  if (v.includes('@')) return v;
  const digits = v.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Cannot derive JID from "${input}"`);
  return `${digits}@s.whatsapp.net`;
}

export function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isLid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

export function bareNumber(jid) {
  if (typeof jid !== 'string') return null;
  return jid.split('@')[0].split(':')[0] || null;
}

/**
 * Pull a real phone number out of a Baileys 7+ message.
 *
 * WhatsApp's "phone number visibility" rollout means many fields now
 * carry a `@lid` (logical id) instead of a phone number. We try, in
 * order, the fields Baileys exposes that *do* carry the real phone:
 *
 *   1. `key.senderPn`         — sender phone (when remoteJid/participant is @lid)
 *   2. `key.remoteJidAlt`     — alternate JID for the chat (phone version of @lid)
 *   3. `participantPn`        — participant phone in groups
 *   4. fallback: bareNumber() of whatever JID we have
 *
 * Returns the bare digits without the "@" suffix, or null if nothing usable.
 */
export function extractPhone(raw, jid) {
  if (!raw?.key) return bareNumber(jid);
  const k = raw.key;
  const candidates = [
    k.senderPn,
    k.participantPn,
    k.remoteJidAlt,
    !isLid(jid) ? jid : null,
  ].filter(Boolean);

  for (const c of candidates) {
    const n = bareNumber(c);
    if (n && /^\d{7,}$/.test(n)) return n;
  }
  return bareNumber(jid); // last resort — may be an @lid number
}
