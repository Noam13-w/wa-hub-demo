import express from 'express';

// Two JSON body parsers with very different ceilings.
//
// The Hub used to parse EVERY request body at the 20 MB media ceiling, as the
// first global middleware — i.e. BEFORE rate-limiting and auth. That let an
// unauthenticated client stream up to 20 MB to any path and force the process to
// buffer+parse it (an OOM/availability risk on the 512 MB-capped box).
//
// Now: the only place that genuinely needs 20 MB is the base64-media send routes
// (/api/messages/send/{image,file,audio}). Everything else (text, location,
// reactions, presence, group ops, webhook config, number checks) is tiny. So we
// parse small by default and apply the 20 MB parser ONLY on the media routes —
// and only at the route level, which sits AFTER the api router's requireAuth, so
// an unauthenticated caller never reaches a 20 MB parser at all.
export const jsonSmall = express.json({ limit: '256kb' });
export const jsonMedia = express.json({ limit: '20mb' });
