# Changelog

## Unreleased — pre-webinar code review polish

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
