# wa-hub-demo — Architecture

Why the Hub is built the way it is. Companion to [API.md](API.md).

```
   phone (WhatsApp)
        │  WhatsApp Web protocol (encrypted)
        ▼
┌─────────────────────────────────────────────────────────┐
│  wa-hub-demo  (Node 20, single process)                  │
│                                                          │
│  src/baileys/    Baileys socket ── normalize ──┐         │
│                   (pairing, reconnect, LID)     │ events │
│  src/state.js    HubState (EventEmitter) ◄──────┘         │
│       │  emits: message.incoming/outgoing/status,        │
│       │         instance.connected/disconnected/qr        │
│       ├──────────────► src/webhook.js  → HMAC POST (retry)│
│       ├──────────────► src/ws/server.js → :3061 broadcast │
│       └──────────────► src/rest/        → :3060 REST API  │
└─────────────────────────────────────────────────────────┘
        │  Cloudflare Tunnel (HTTPS)
        ▼
   any app (Base44, Bubble, Firebase, Make, Python, …)
```

## The pieces

| Module | Responsibility |
|---|---|
| `src/baileys/socket.js` | Owns the Baileys WebSocket: pairing (QR), auto-reconnect with backoff, message/status events. |
| `src/baileys/normalize.js` | Turns a raw Baileys `IMessage` into a stable JSON shape API consumers can rely on. |
| `src/baileys/jid.js` | JID normalization + LID-aware phone extraction (`senderPn`/`participantPn`/`remoteJidAlt`). |
| `src/state.js` | `HubState` — single source of truth (connection, QR, `me`, webhook config) **and** the event bus everything subscribes to. |
| `src/rest/` | Express app + routers (`messages`, `instance`, `groups`, `check`) + `/healthz`. |
| `src/webhook.js` | Outbound webhook dispatcher: HMAC signing + bounded retry. |
| `src/ws/server.js` | WebSocket broadcaster on `:3061`. |
| `src/diagnostics.js` | In-memory/disk ring buffers for errors & webhook failures, the `/diagnose` self-test, pending-delivery counter. |
| `src/config.js` | `zod`-validated env config; the process **exits** on invalid config. |
| `src/index.js` | Wires it all together; heartbeat + graceful shutdown. |

## Event flow

Everything funnels through `HubState` (an `EventEmitter`). Baileys callbacks `state.emit(...)`;
the REST layer reads `state.connection`/`state.qr`; the webhook dispatcher and the WS server are just
two subscribers. Adding a third consumer (e.g. a metrics sink) is one `state.on(...)` line.

- **Incoming vs outgoing** is decided in `socket.js` by `message.key.fromMe`.
- **Status receipts** map Baileys' numeric ack codes to `sent/delivered/read/played` (`STATUS_LABELS`).

## Deliberate design decisions

- **No auto-reconnect on `loggedOut` / `connectionReplaced` (440).** If the primary phone unlinked the
  device, or another session took over, silently reconnecting would either fail forever or start a
  session war. The Hub stops and waits for an explicit re-pair (`POST /api/instance/logout`).
- **`syncFullHistory: false` + `markOnlineOnConnect: false`.** We don't download old history and don't
  announce "online" — less RAM, less traffic, fewer side effects on the user's real account.
- **Webhook config precedence: `data/webhook.json` > `.env`.** A runtime `PUT /api/instance/webhook`
  persists to disk and wins over the env defaults, so the webhook survives restarts without editing `.env`.
- **Bounded webhook retry, never on 4xx.** Retries (immediate, +2 s, +6 s, +18 s) only on `5xx/408/429/network`.
  A `4xx` means the receiver rejected the payload — retrying just wastes work; it's logged instead.
- **Fire-and-forget delivery + pending counter.** Sends don't block on webhook delivery; a counter exposed
  in `/healthz` and drained on shutdown gives visibility without a queue dependency.
- **In-memory rings, no database.** Errors (≤50) and webhook failures (≤100) live in small buffers
  surfaced via `/api/instance/errors` and `/webhook/failures`. One instance = one number = one process;
  there is intentionally no shared store.
- **LID handling.** Since WhatsApp's phone-visibility rollout, JIDs are often `@lid`. `extractPhone()`
  tries the fields that still carry a real number; `fromLid` flags when it couldn't.

## Security posture

- **Bearer auth** (constant-time) on every `/api/*` route + per-minute rate limit.
- **Webhooks are signed** (`HMAC-SHA256`, `x-hub-signature`); receivers must verify over the raw body.
- **Loopback by default.** The Hub binds `0.0.0.0` but the firewall (ufw) only opens SSH; public access
  is via Cloudflare Tunnel, so no inbound port is exposed.
- **Hardened systemd unit** (`deploy/wa-hub.service`): `NoNewPrivileges`, `ProtectSystem=strict`,
  empty `CapabilityBoundingSet`, `MemoryMax=512M`, etc. (`SystemCallFilter` is intentionally left unset
  because Node 20+ uses syscalls the strict allow-list blocks — see the comment in the unit.)
- **Secrets** (`HUB_TOKEN`, `WEBHOOK_SECRET`) live only in `.env` (`chmod 600`), never in git.

## Process lifecycle

REST and WS come up immediately; Baileys boots asynchronously so the API answers while a QR is
generated. A 5-minute heartbeat logs RSS (and WARNs past 80% of `MemoryMax`) so leaks are visible in
`journalctl`. `SIGTERM`/`SIGINT` trigger a graceful drain (≤12 s) within the unit's `TimeoutStopSec=15`.

See [DEPLOY.md](DEPLOY.md) for running it in production.
