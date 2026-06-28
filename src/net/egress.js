import { isIP } from 'node:net';
import { Agent, buildConnector, request } from 'undici';
import { config } from '../config.js';

/**
 * SSRF egress guard.
 *
 * The Hub makes two kinds of outbound HTTP requests with attacker-influenceable
 * targets: outbound webhooks (URL set via PUT /api/instance/webhook) and media
 * fetches (imageUrl/fileUrl/audioUrl on the send endpoints). Without controls a
 * token holder could point either at the host loopback, RFC1918 ranges, or the
 * link-local cloud-metadata endpoint (169.254.169.254) — a trust-boundary
 * crossing from "send WhatsApp messages" to "reach the internal network".
 *
 * Defenses here:
 *   1. Scheme allowlist — only http(s).
 *   2. Literal-IP pre-check — reject URLs whose host is a private/reserved IP.
 *   3. Connect-time IP guard — a custom undici connector inspects the ACTUAL
 *      socket.remoteAddress after the TCP/TLS handshake and aborts before any
 *      application bytes are sent. This is what defeats DNS rebinding: even if a
 *      hostname resolves to a public IP at check time and a private IP at
 *      connect time, we validate the address we genuinely connected to.
 *   4. Manual, re-validated redirect following for media (each hop re-checked).
 *
 * Operators who legitimately need to reach a private/loopback receiver (e.g. a
 * webhook consumer on the same box) can opt out with ALLOW_PRIVATE_EGRESS=true,
 * which keeps the scheme allowlist but disables the private-range blocking.
 */

export class EgressError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.name = 'EgressError';
    this.code = code;
    // Most egress rejections are caller errors (bad/blocked URL) → 400. Size-cap
    // violations are 413 so the API matches the documented `413 file_too_large`.
    this.status = status;
  }
}

// ─── IPv4 classification ────────────────────────────────────────────────
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

// base CIDR, prefix bits — everything here is non-public and must be blocked.
const BLOCK4 = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved / 255.255.255.255 broadcast
];

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  for (const [base, bits] of BLOCK4) {
    const b = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (b & mask)) return true;
  }
  return false;
}

// ─── IPv6 classification ────────────────────────────────────────────────
function isPrivateIpv6(ip) {
  let a = String(ip).split('%')[0].toLowerCase(); // strip zone id
  if (a === '::1' || a === '::') return true;                 // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) — classify by the embedded v4.
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if ((a.startsWith('::ffff:') || a.startsWith('64:ff9b:')) && v4) return isPrivateIpv4(v4[1]);
  if (a.startsWith('::ffff:')) return true;     // hex-form mapped we can't cheaply split → unsafe
  if (a.startsWith('fc') || a.startsWith('fd')) return true;  // fc00::/7 unique-local
  if (/^fe[89a-f]/.test(a)) return true;                      // fe80::/10 link-local + fec0::/10 site-local
  if (a.startsWith('ff')) return true;                        // multicast
  if (a.startsWith('64:ff9b:')) return true;                  // NAT64 without dotted tail
  return false;
}

export function isPublicIp(ip) {
  const fam = isIP(ip);
  if (fam === 4) return !isPrivateIpv4(ip);
  if (fam === 6) return !isPrivateIpv6(ip);
  return false;
}

function privateEgressAllowed() {
  return config.ALLOW_PRIVATE_EGRESS === true;
}

/**
 * Validate a URL string: must be http(s); if the host is a literal IP it must be
 * public (unless ALLOW_PRIVATE_EGRESS). Returns a URL object or throws EgressError.
 */
export function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new EgressError('invalid_url', 'URL is not parseable');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new EgressError('scheme_not_allowed', 'Only http(s) URLs are allowed');
  }
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!privateEgressAllowed() && isIP(host) && !isPublicIp(host)) {
    throw new EgressError('private_address', 'URL targets a private/reserved address');
  }
  return u;
}

// ─── Connect-time guard ─────────────────────────────────────────────────
const rawConnect = buildConnector({ timeout: 10_000 });

function guardedConnect(opts, cb) {
  rawConnect(opts, (err, socket) => {
    if (err) return cb(err);
    const ip = socket?.remoteAddress;
    if (!ip || !isPublicIp(ip)) {
      try { socket.destroy(); } catch { /* ignore */ }
      return cb(new EgressError('egress_blocked', `blocked connection to non-public address ${ip || 'unknown'}`));
    }
    return cb(null, socket);
  });
}

let _guardedAgent = null;
/**
 * Shared undici dispatcher that refuses connections to non-public addresses.
 * Returns undefined when ALLOW_PRIVATE_EGRESS is set (use the global dispatcher;
 * the scheme allowlist in assertSafeUrl still applies).
 */
export function guardedAgent() {
  if (privateEgressAllowed()) return undefined;
  // Cap per-origin connections so a burst of webhook/media requests can't open an
  // unbounded number of sockets to one host.
  if (!_guardedAgent) _guardedAgent = new Agent({ connect: guardedConnect, connections: 64 });
  return _guardedAgent;
}

/**
 * Fetch an http(s) URL into a Buffer with SSRF protection and a hard size cap.
 * Follows up to 3 redirects, re-validating every hop. Used for media-by-URL so
 * Baileys never receives the raw URL (closing the rebinding + redirect vectors).
 */
export async function safeFetchToBuffer(rawUrl, { maxBytes }) {
  const dispatcher = guardedAgent();
  let current = assertSafeUrl(rawUrl);

  for (let hop = 0; hop <= 3; hop++) {
    const { statusCode, headers, body } = await request(current, {
      method: 'GET',
      dispatcher,
      maxRedirections: 0,
      headersTimeout: 10_000,
      bodyTimeout: 30_000,
      headers: { 'user-agent': `wa-hub-demo/${config.HUB_NAME}`, accept: '*/*' },
    });

    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      try { await body.dump(); } catch { /* ignore */ }
      if (hop === 3) throw new EgressError('too_many_redirects', 'media URL redirected too many times');
      current = assertSafeUrl(new URL(String(headers.location), current).toString());
      continue;
    }
    if (statusCode >= 400) {
      try { await body.dump(); } catch { /* ignore */ }
      throw new EgressError('upstream_error', `media URL returned HTTP ${statusCode}`);
    }

    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await body.dump(); } catch { /* ignore */ }
      throw new EgressError('file_too_large', `media exceeds ${maxBytes} bytes`, 413);
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        try { body.destroy(); } catch { /* ignore */ }
        throw new EgressError('file_too_large', `media exceeds ${maxBytes} bytes`, 413);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new EgressError('too_many_redirects', 'media URL redirected too many times');
}
