# wa-hub-demo

> **Self-hosted WhatsApp HTTP API. Green-API style, fully yours.**
> Node 20 + [Baileys](https://github.com/WhiskeySockets/Baileys). Single-tenant.
> Built for the *"How to ship a WhatsApp bot in 45 minutes"* webinar — but production-grade.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()
[![Baileys](https://img.shields.io/badge/baileys-7.0.0--rc13-blue)]()

---

## What you get

A REST + WebSocket + outbound-webhook layer on top of WhatsApp Web — clean,
typed, rate-limited, HMAC-signed, ready to deploy on any €4/mo Linux VPS.

```
┌──────────────┐    ┌──────────────────────────────┐    ┌──────────────┐
│  WhatsApp    │ ←→ │  wa-hub-demo                 │ ←→ │  Your app    │
│  (paired     │    │  ├─ Baileys (WA protocol)    │    │  (Base44,    │
│   phone)     │    │  ├─ REST :3060               │    │   n8n, Make, │
│              │    │  ├─ WebSocket :3061          │    │   anything   │
│              │    │  └─ Signed webhooks (HMAC)   │    │   else)      │
└──────────────┘    └──────────────────────────────┘    └──────────────┘
```

## Why?

| Self-hosted (this) | Hosted services (Green-API, Wassenger, ...) |
|---|---|
| €3.79/mo flat | $20–$200+/mo, often per-message |
| You own the messages | They proxy them |
| No external rate-limits | Their limits |
| You patch and monitor | They patch and monitor |

If your volume is moderate **and** you care about cost/privacy/control — self-host.
If you need 99.99% SLA without ops work — pay someone.

## Quickstart

> 📘 **For a step-by-step "buy a server → live API in 45 minutes" walkthrough**,
> read **[docs/BUILD_GUIDE_HE.md](docs/BUILD_GUIDE_HE.md)** (Hebrew).
> It covers VPS purchase, SSH hardening, manual install, pairing, Cloudflare Tunnel,
> and a Base44 integration example.

For the impatient — locally, just to test:

```bash
git clone https://github.com/noamnissan/wa-hub-demo.git
cd wa-hub-demo
cp .env.example .env
# edit .env — set HUB_TOKEN and WEBHOOK_SECRET to long random strings
#   openssl rand -hex 32
npm install
npm start
```

Then in another terminal:

```bash
# 1. Save the QR as a PNG and open it
TOKEN=$(grep HUB_TOKEN .env | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:3060/api/instance/qr.png > qr.png
open qr.png   # or: xdg-open / start

# 2. Scan from WhatsApp → Settings → Linked Devices

# 3. Send your first message
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"to":"+972501234567","text":"Hello, world!"}' \
     http://localhost:3060/api/messages/send/text
```

## API at a glance

All `/api/*` endpoints require `Authorization: Bearer <HUB_TOKEN>`.

| Method | Path | What it does |
|---|---|---|
| `GET`  | `/healthz` | Liveness check (no auth) |
| `GET`  | `/api/instance/status` | Connection state + paired device info |
| `GET`  | `/api/instance/qr` | Current QR (JSON, base64) |
| `GET`  | `/api/instance/qr.png` | Current QR (raw PNG, openable in browser) |
| `POST` | `/api/instance/logout` | Wipe auth, force re-pair |
| `GET`/`PUT` | `/api/instance/webhook` | Get/set outbound webhook URL + event filter |
| `POST` | `/api/messages/send/text` | `{ to, text, quotedMessageId? }` |
| `POST` | `/api/messages/send/image` | `{ to, imageUrl\|imageBase64, caption? }` |
| `POST` | `/api/messages/send/file` | `{ to, fileUrl\|fileBase64, filename, mimetype? }` |
| `POST` | `/api/messages/send/audio` | `{ to, audioUrl\|audioBase64, ptt? }` |
| `POST` | `/api/messages/send/location` | `{ to, latitude, longitude, name?, address? }` |
| `POST` | `/api/messages/send/reaction` | `{ to, messageId, emoji }` |
| `POST` | `/api/messages/markRead` | `{ to, messageId }` |
| `POST` | `/api/check/number` | `{ numbers: [...] }` → which are on WhatsApp |
| `GET`  | `/api/groups` | List all groups you're a member of |
| `GET`  | `/api/groups/:jid` | Group metadata |
| `POST` | `/api/groups/:jid/participants` | `{ add\|remove\|promote\|demote: [...] }` |

Full reference with request/response examples: **[docs/API.md](docs/API.md)**

## Incoming events (webhook payload)

When `instance.webhook.url` is set, the hub POSTs JSON to that URL on every event,
signed with HMAC-SHA256 in the `X-Hub-Signature: sha256=<hex>` header (same
convention as GitHub webhooks).

```json
{
  "event": "message.incoming",
  "timestamp": 1779983575127,
  "instance": "wa-hub",
  "data": {
    "id": "ABCD1234EFGH",
    "chat": "972501234567@s.whatsapp.net",
    "isGroup": false,
    "from": "972501234567@s.whatsapp.net",
    "fromMe": false,
    "fromNumber": "972501234567",
    "fromName": "Noam",
    "type": "text",
    "text": "Hi!",
    "media": null,
    "quoted": null
  }
}
```

**Always verify the signature** before trusting the payload — see the verifier
snippet in [examples/base44/webhook-receiver.ts](examples/base44/webhook-receiver.ts).

### Event types

- `message.incoming` — received message
- `message.outgoing` — message sent (echo, even sends from your phone)
- `message.status` — delivery receipt (sent → delivered → read)
- `instance.connected` — paired and online
- `instance.disconnected` — connection dropped (auto-reconnecting)
- `instance.qr` — new QR generated (the QR itself is **not** included in the payload — fetch it from `/api/instance/qr` over your trusted channel)

## Project layout

```
wa-hub-demo/
├── src/
│   ├── index.js              ← entry point
│   ├── config.js             ← env validation (zod)
│   ├── logger.js             ← pino
│   ├── state.js              ← singleton state + event bus
│   ├── webhook.js            ← outbound webhook dispatcher (signed)
│   ├── auth.js               ← Bearer middleware + rate limit
│   ├── baileys/
│   │   ├── socket.js         ← Baileys lifecycle (connect, reconnect, QR)
│   │   ├── normalize.js      ← convert raw Baileys messages → clean JSON
│   │   └── jid.js            ← JID utilities (number → JID)
│   ├── rest/
│   │   ├── server.js         ← express app
│   │   └── routes/
│   │       ├── instance.js   ← status, QR, webhook config, logout
│   │       ├── messages.js   ← send text/image/file/audio/location/reaction
│   │       ├── groups.js     ← list groups, participants admin
│   │       └── check.js      ← does this number have WhatsApp?
│   └── ws/
│       └── server.js         ← WebSocket broadcaster
├── deploy/
│   ├── wa-hub.service        ← hardened systemd unit
│   ├── install.sh            ← optional one-command installer
│   └── cloudflared-setup.sh  ← Cloudflare Tunnel helper
├── docs/
│   ├── BUILD_GUIDE_HE.md     ← the full webinar walkthrough (Hebrew)
│   ├── API.md                ← endpoint-by-endpoint reference
│   ├── ARCHITECTURE.md       ← why it's built the way it is
│   └── DEPLOY.md             ← production deployment notes
└── examples/
    └── base44/               ← copy-pasteable Base44 functions
```

## Security model

- **Bearer auth** — all `/api/*` endpoints. Token is compared in constant time.
- **HMAC-signed webhooks** — outbound payloads carry `X-Hub-Signature`. Verify it.
- **Loopback-only by default** — the listener binds to `0.0.0.0`, but `ufw` should
  block `:3060` from the internet. Use Cloudflare Tunnel (or nginx + Let's Encrypt
  + IP allowlist) to expose it.
- **systemd hardening** — `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=tmpfs`,
  `CapabilityBoundingSet=`, `SystemCallFilter=@system-service`, `MemoryMax=512M`.
- **Rate-limited** — per-token, configurable (`RATE_LIMIT_PER_MIN`).
- **No secrets in code** — everything in `.env`, which is gitignored.

## Configuration

See [`.env.example`](.env.example) for the full list. The only required vars are:

| Var | Description |
|---|---|
| `HUB_TOKEN` | Bearer token clients must send. Generate: `openssl rand -hex 32` |
| `HUB_TOKEN` | HMAC secret for webhook signatures. Generate: `openssl rand -hex 32` |

Everything else has sensible defaults.

## Examples

- [`examples/base44/send-message.ts`](examples/base44/send-message.ts) — Base44 function that calls the hub to send a message
- [`examples/base44/webhook-receiver.ts`](examples/base44/webhook-receiver.ts) — Base44 function that receives incoming messages (with signature verification)
- [`examples/curl/`](examples/curl/) — shell snippets for every endpoint

## Roadmap

- [ ] Persistent message store (currently in-memory only)
- [ ] Pluggable storage backends (SQLite, Postgres)
- [ ] Multi-tenant mode (one Hub managing many numbers)
- [ ] Built-in nginx config + Let's Encrypt setup
- [ ] Docker image
- [ ] Prometheus metrics endpoint

PRs welcome.

## License

[MIT](LICENSE) © 2026 Noam Nissan

## Acknowledgements

- [@WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — the heart of this project. Without it, none of this is possible.
- Green-API — for showing that simple HTTP > complex SDK.
