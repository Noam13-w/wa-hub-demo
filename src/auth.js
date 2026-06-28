import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { timingSafeStringEqual } from './security/compare.js';

/**
 * Constant-time comparison of the provided token to the configured one.
 * Hashes both sides first, so neither timing nor the early-return leaks the
 * token's length (see security/compare.js).
 */
function tokenMatches(provided) {
  return timingSafeStringEqual(typeof provided === 'string' ? provided : '', config.HUB_TOKEN);
}

/**
 * Extract the Bearer token. The Authorization header is always accepted; the
 * ?token= query fallback is OFF unless ALLOW_QUERY_TOKEN is set (query strings
 * leak into proxy/access logs and browser history — CWE-598).
 */
function extractToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  if (config.ALLOW_QUERY_TOKEN && typeof req.query.token === 'string') return req.query.token;
  return undefined;
}

export function requireAuth(req, res, next) {
  if (!tokenMatches(extractToken(req))) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Bearer token' });
  }
  next();
}

/**
 * Extra gate for destructive/config routes. When ADMIN_TOKEN is configured it
 * must be supplied via the X-Admin-Token header (in addition to the normal
 * Bearer auth). When it is not set this is a no-op, preserving the simple
 * single-token model for users who don't need privilege separation.
 */
export function requireAdmin(req, res, next) {
  if (!config.ADMIN_TOKEN) return next();
  const provided = req.get('x-admin-token') || '';
  if (!timingSafeStringEqual(provided, config.ADMIN_TOKEN)) {
    return res.status(403).json({ error: 'forbidden', message: 'This route requires the X-Admin-Token header' });
  }
  next();
}

/**
 * Rate-limit key. Behind a trusted proxy/tunnel, prefer Cloudflare's
 * CF-Connecting-IP (a single value the edge sets and clients cannot append to),
 * falling back to req.ip. Without TRUST_PROXY we MUST NOT trust forwarded
 * headers — a direct client could spoof them — so we key on the socket IP only.
 */
function clientKey(req) {
  if (config.TRUST_PROXY) {
    const cf = req.get('cf-connecting-ip');
    if (cf) return cf.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// We supply an explicit, proxy-aware key generator above, so the library's
// built-in IPv6/trust-proxy fallback heuristics don't apply — silence them.
const rateValidate = { ip: false, trustProxy: false };

export const apiRateLimit =
  config.RATE_LIMIT_PER_MIN > 0
    ? rateLimit({
        windowMs: 60_000,
        limit: config.RATE_LIMIT_PER_MIN,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: clientKey,
        validate: rateValidate,
        message: { error: 'rate_limited', message: 'Too many requests, slow down.' },
      })
    : (_req, _res, next) => next();

// Lighter limiter for the unauthenticated /healthz so it can't be flooded for
// availability degradation, while still serving legitimate uptime monitors.
export const healthRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: rateValidate,
  message: { error: 'rate_limited' },
});

// Coarse, always-on flood guard applied to EVERY request BEFORE the JSON body is
// parsed (and before auth). Without it an unauthenticated client could stream
// large bodies to any path — including /api before requireAuth runs — and make
// the process buffer/parse them, an availability/OOM risk on the 512 MB-capped
// box. The ceiling is deliberately generous (well above the per-route API quota)
// so it only ever trips on an actual flood, never on legitimate traffic.
export const globalRateLimit = rateLimit({
  windowMs: 60_000,
  limit: Math.max((config.RATE_LIMIT_PER_MIN || 0) * 4, 600),
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: clientKey,
  validate: rateValidate,
  message: { error: 'rate_limited' },
});
