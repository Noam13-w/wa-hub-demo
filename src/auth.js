import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';

/**
 * Constant-time comparison of the provided Bearer token to the configured one.
 */
function tokenMatches(provided) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.HUB_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : req.query.token;
  if (!tokenMatches(token)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Bearer token' });
  }
  next();
}

export const apiRateLimit =
  config.RATE_LIMIT_PER_MIN > 0
    ? rateLimit({
        windowMs: 60_000,
        limit: config.RATE_LIMIT_PER_MIN,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'rate_limited', message: 'Too many requests, slow down.' },
      })
    : (_req, _res, next) => next();
