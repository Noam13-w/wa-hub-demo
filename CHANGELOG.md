# Changelog

## Unreleased — pre-webinar hardening pass (round 2)

Focused on webhook delivery resilience, observability, and stricter input validation
for the live webinar. No public API breaking changes.

### Added

- **Exponential-backoff webhook retries.** `src/webhook.js` now attempts delivery
  up to 4 times — at `t=0`, `+2s`, `+6s`, `+18s`. Retries **only** on network errors,
  `5xx`, `408`, and `429`. Other `4xx` responses abort immediately (a `400` won't fix
  itself by being re-sent — we just log and move on). Total worst-case wall-clock per
  failed event: ~26 s. Still fire-and-forget; never blocks the bot event loop.
- **Disk-backed webhook failure log.** Failed deliveries are recorded to
  `${DATA_DIR}/webhook-failures.json` (capped at the last 100). Survives restart.
  Retrievable via `GET /api/instance/webhook/failures`.
- **In-memory error ring buffer.** Last 50 unhandled route / process errors are
  kept and exposed via `GET /api/instance/errors`. Helps post-mortem the live demo
  without grepping `journalctl`.
- **Self-test endpoint.** `GET /api/instance/diagnose` runs a quick health battery:
  - public internet reachability (curl ifconfig.me)
  - auth-dir exists + writable
  - required env vars present
  - underlying Baileys socket open
  Returns a structured JSON with `summary: pass | degraded | fail`.
- **Richer `/healthz`.** Now reports `connection`, `qr` (boolean — pending or not),
  `webhookConfigured`, `pendingDeliveries`, `recentErrors`, `recentWebhookFailures`,
  and `version` (from `package.json`).
- **5-minute memory heartbeat.** `src/index.js` logs `rss`, `heapUsed`, `heapTotal`,
  `external`, `pendingDeliveries` every 5 min — so a leak is visible in `journalctl`.
  Logs a `WARN` when RSS crosses 80% of systemd `MemoryMax=512M` to give the user
  a heads-up before OOM-kill.
- **Strict input validation on all REST routes.**
  - Recipient (`to`) must match `/^(\+?\d{7,15}|\d{7,15}@s\.whatsapp\.net|\d{15,}@g\.us|\d{1,20}@lid)$/`.
    Bad recipients now return `400 invalid_body` instead of failing later inside Baileys.
  - `imageBase64` / `fileBase64` / `audioBase64` are hard-capped at 20 MB **decoded**
    (the previous express body cap was on the encoded JSON). Oversized media returns
    `400 invalid_body` with `message: "file_too_large — max 20971520 bytes (20 MB) decoded"`.
  - `filename` / `mimetype` / `messageId` have explicit max lengths.
  - `latitude` / `longitude` are clamped to valid earth coordinates.
  - Group routes reject non-`@g.us` JIDs and cap each participant list at 50.
- **CSP + nosniff** on `/healthz` and `/api/instance/qr.png` — the two endpoints
  most likely to be opened in a browser tab. Strict policy:
  `default-src 'none'; img-src 'self' data:; ... frame-ancestors 'none'`.
- **`TimeoutStopSec=15`** added to `deploy/wa-hub.service` so systemd doesn't
  `SIGKILL` us mid-shutdown. Matches the 12 s graceful budget in `src/index.js`.

### Changed

- **Per-request access log** now includes status code and response time in ms.
  Previously was just method + path. Still skips `/healthz`. Still never logs
  headers or bodies (no token leakage).
- **Graceful shutdown budget** raised from 8 s to 12 s and now logs how many
  pending webhook deliveries drained vs. were abandoned.
- **JSON-only errors.** The Express last-resort handler always returns JSON,
  never the default HTML 500 page. `entity.too.large` (oversized JSON body)
  now returns `413 payload_too_large` JSON.
- **All async route handlers wrapped.** A small `wrap()` helper removes the
  manual `try/catch + next(err)` per route. No behavior change, just consistency.

### Security

- Reconfirmed all `/api/*` routes go through `requireAuth` + `apiRateLimit`.
  No bypass found.
- Reconfirmed Bearer comparison uses `timingSafeEqual` (REST and WS both).
- Reconfirmed `HUB_TOKEN` / `WEBHOOK_SECRET` are never logged. Diagnose endpoint
  reports only presence/absence, never length or value.
- Request log uses `req.path` (not `req.url`), so even if a caller passes
  `?token=...` it won't be persisted to `journalctl`.

### Notes

- No dependency bumps.
- The webhook retry buffer is per-event, in-memory while in flight. If the Hub
  is killed (OOM, kernel panic) while a retry is queued, that event is lost.
  Persisting the queue to disk is the next step — not done in this pass to keep
  the change surface small for the webinar.

## Previous — pre-webinar code review polish

### Added
- **Human-readable message statuses.** The `message.status` event (webhook + WS) now
  carries `status: "sent" | "delivered" | "read" | "played" | "pending" | "error"`
  alongside the original numeric `statusCode` (0..5). Consumers no longer need to
  memorize Baileys' numeric ack table to render WhatsApp blue ticks (`messages.update`
  raw codes: 2=server ack, 3=delivered, 4=read).
- **Webhook delivery retry.** `src/webhook.js` now retries once after 2 s when the
  first POST fails or returns a non-2xx. Still fire-and-forget — never blocks the
  bot event loop — but recovers gracefully from transient receiver hiccups.
- **Runtime webhook persistence.** `PUT /api/instance/webhook` now writes the URL +
  event filter to `${DATA_DIR}/webhook.json`. On boot the Hub loads the file (if
  present) before falling back to the `.env` defaults, so a runtime-configured
  webhook now survives `systemctl restart wa-hub` without re-editing `.env`.
- **Graceful shutdown.** `src/index.js` now handles `SIGTERM` / `SIGINT`. On signal
  it stops accepting new HTTP connections, closes WS clients with code 1001, ends
  the Baileys socket, and exits cleanly. Hard timeout of 8 s as a fail-safe.
- **`status.fromMe` field** propagated into `message.status` events so receivers
  can distinguish their own outbound message acks from ones they received.

### Changed
- **Reconnect now refuses to fight a replaced session.** When Baileys disconnects
  with code 440 (`DisconnectReason.connectionReplaced`) we log the takeover and
  stop reconnecting, just like we already do for `loggedOut`. Previously the Hub
  would re-pair and steal the session back, which causes an endless ping-pong if
  another client (or a stale process) is also live.

### Notes
- No dependency bumps.
- No test coverage added in this pass.
- No public API breaking changes — `statusCode` preserves the old numeric value
  for any consumer that was depending on it.
