import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  HUB_NAME: z.string().min(1).default('wa-hub-demo'),
  HUB_TOKEN: z.string().min(16, 'HUB_TOKEN must be at least 16 chars'),
  // Optional separate admin token. When set, destructive/config routes
  // (POST /instance/logout, PUT /instance/webhook) additionally require it via
  // the X-Admin-Token header — privilege separation from the send/read token.
  ADMIN_TOKEN: z
    .string()
    .min(16, 'ADMIN_TOKEN must be at least 16 chars')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  HUB_PORT: z.coerce.number().int().positive().default(3060),
  WS_PORT: z.coerce.number().int().positive().default(3061),
  // Bind addresses. Default to loopback so the API/WS are reachable only via a
  // reverse proxy / tunnel on the same host. Set to 0.0.0.0 to expose directly
  // (then you MUST firewall the ports yourself).
  HUB_HOST: z.string().min(1).default('127.0.0.1'),
  WS_HOST: z.string().min(1).default('127.0.0.1'),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 chars'),
  WEBHOOK_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'WEBHOOK_URL must be an http(s) URL',
    })
    .optional()
    .or(z.literal('').transform(() => undefined)),
  WEBHOOK_EVENTS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().nonnegative().default(120),
  // Max concurrent media (image/file/audio) sends. Bounds peak memory from
  // simultaneous multi-MB decodes/uploads. Excess requests queue, then 503.
  MEDIA_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Max simultaneous WebSocket clients. Excess connections are closed (1013).
  WS_MAX_CLIENTS: z.coerce.number().int().positive().default(64),
  // Allow outbound webhook/media requests to private/loopback/link-local
  // addresses. OFF by default (blocks SSRF to internal services & cloud
  // metadata). Enable only if your webhook receiver runs on a private network.
  ALLOW_PRIVATE_EGRESS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Accept the API token via the ?token= query string on REST routes. OFF by
  // default — URLs leak into proxy/access logs and browser history. The
  // Authorization: Bearer header is always accepted.
  ALLOW_QUERY_TOKEN: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // Optional comma-separated Origin allowlist for WebSocket clients. Empty =
  // no Origin restriction (browser WS still needs the token, which a malicious
  // site cannot read — so this is defense-in-depth, not the primary control).
  WS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  // Trust X-Forwarded-* headers (enable only behind a reverse proxy / tunnel you
  // control, so the rate limiter sees real client IPs). Accepts true/1; else false.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // ─── Anti-ban send pacing ──────────────────────────────────────────────
  // Every WhatsApp send funnels through one FIFO queue. By default it only
  // SERIALIZES sends (no added delay) so behaviour is unchanged. Set these to add
  // a human-like randomized gap between sends and a typing indicator — strongly
  // recommended for any real outbound volume (robotic timing/velocity is the #1
  // ban trigger). Safe production profile:
  //   SEND_MIN_DELAY_MS=3000  SEND_MAX_DELAY_MS=8000  SEND_TYPING=true
  SEND_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  SEND_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  // Send a "composing"/"recording" chatstate before each message (WhatsApp does
  // NOT do this automatically; sending with no typing indicator is a bot tell).
  SEND_TYPING: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  SEND_TYPING_MS_PER_CHAR: z.coerce.number().int().nonnegative().default(60),
  SEND_TYPING_MAX_MS: z.coerce.number().int().positive().default(8000),
  // Max tasks queued in the outbound send/pacing FIFO before new sends are shed
  // with a 503. Bounds memory (each queued media send retains its decoded bytes)
  // and stops a flood from growing the chain without limit when pacing is on.
  SEND_QUEUE_MAX: z.coerce.number().int().positive().default(500),
  // ─── Webhook delivery bounds ───────────────────────────────────────────
  // Cap concurrent in-flight webhook POSTs and the backlog behind them, so a slow
  // or failing receiver during an inbound burst can't accumulate unbounded retained
  // bodies / retry timers / sockets. Past the backlog cap, deliveries are shed.
  WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WEBHOOK_MAX_QUEUE: z.coerce.number().int().positive().default(1000),
}).refine((c) => c.HUB_PORT !== c.WS_PORT, {
  message: 'HUB_PORT and WS_PORT must be different',
  path: ['WS_PORT'],
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
