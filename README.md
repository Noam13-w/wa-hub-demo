# wa-hub-demo

> **Self-hosted WhatsApp HTTP API. Run it yourself, own your messages.**
> Node 20 + [Baileys](https://github.com/WhiskeySockets/Baileys). Single-tenant.
> Built for the *"How to ship a WhatsApp bot in 45 minutes"* webinar — built with
> production hardening in mind (rate limiting, HMAC-signed webhooks, systemd sandboxing).

**🌐 Language:** **English** · [עברית](README.he.md)

> ⚠️ **Disclaimer — read before you deploy.** Not affiliated with, endorsed by, or sponsored by **WhatsApp or Meta**. This uses the unofficial, reverse-engineered [Baileys](https://github.com/WhiskeySockets/Baileys) library and connects by impersonating a WhatsApp "linked device" — which **may violate [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service)** and can get the connected number **banned** at Meta's sole discretion, especially for bulk or unsolicited messaging. Provided **"as is", no warranty**. **You alone are responsible** for messaging only people who gave prior opt-in consent and for complying with applicable law (GDPR, CAN-SPAM, TCPA, Israel's §30A "Spam Law"). Not legal advice. → **[DISCLAIMER.md](DISCLAIMER.md)**

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

| Self-hosted (this) | Hosted SaaS providers |
|---|---|
| Low flat VPS cost (~a few €/mo) | Typically a monthly subscription, often with per-message or volume-based pricing |
| You run the connection yourself | The provider operates the connection on your behalf |
| No third-party rate limits beyond WhatsApp's | The provider may apply its own limits |
| You patch and monitor | They patch and monitor |

> Pricing and feature models of hosted providers vary and change over time — check each
> provider's current terms. This comparison is general and illustrative, not a statement
> about any specific provider.

If your volume is moderate **and** you care about cost/privacy/control — self-host.
If you need a contractual uptime SLA without doing ops work yourself — use a managed service.

## Quickstart

> 📘 **For a step-by-step "buy a server → live API in 45 minutes" walkthrough**,
> read the full build guide — **[English](docs/BUILD_GUIDE_EN.md)** · **[עברית](docs/BUILD_GUIDE_HE.md)**.
> It covers VPS purchase, SSH hardening, manual install, pairing, Cloudflare Tunnel,
> and a Base44 integration example.

For the impatient — locally, just to test:

```bash
git clone https://github.com/Noam13-w/wa-hub-demo.git
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
| `GET`  | `/healthz` | Liveness check (no auth). Returns `connection`, `qr`, `webhookConfigured`, `pendingDeliveries`, `recentErrors`, `recentWebhookFailures`, `version`, `uptimeMs` |
| `GET`  | `/api/instance/status` | Connection state + paired device info |
| `GET`  | `/api/instance/qr` | Current QR (JSON, base64) |
| `GET`  | `/api/instance/qr.png` | Current QR (raw PNG, openable in browser) |
| `GET`  | `/api/instance/diagnose` | Self-test: internet reachability, auth dir, env, socket state |
| `GET`  | `/api/instance/errors` | Last 50 unhandled errors (in-memory) |
| `GET`  | `/api/instance/webhook/failures` | Last 100 failed webhook deliveries (disk-backed) |
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
| `WEBHOOK_SECRET` | HMAC secret for webhook signatures. Generate: `openssl rand -hex 32` |

Everything else has sensible defaults.

## Examples

- [`examples/base44/send-message.ts`](examples/base44/send-message.ts) — Base44 function that calls the hub to send a message
- [`examples/base44/webhook-receiver.ts`](examples/base44/webhook-receiver.ts) — Base44 function that receives incoming messages (with signature verification)
- [`examples/curl/`](examples/curl/) — shell snippets for every endpoint

## Production checklist

Before you call it live, run through this list. Every item maps to a specific
hardening pass already implemented — verify each one in your environment.

### 1. Boot & connectivity

- [ ] `curl http://localhost:3060/healthz` returns `{ ok: true }` with a valid
      `version` and `connection: "connected"`.
- [ ] `curl -H "Authorization: Bearer $TOKEN" http://localhost:3060/api/instance/diagnose`
      returns `summary: "pass"`. If `degraded` or `fail`, the JSON tells you which
      check failed (internet, auth-dir, env, socket).
- [ ] Send a test text message to your own number and confirm it arrives.

### 2. Webhook delivery

- [ ] Set `WEBHOOK_URL` (or `PUT /api/instance/webhook`) to your receiver.
- [ ] Send yourself a message; confirm the receiver got the `message.incoming` event.
- [ ] Verify the HMAC signature on the receiver side (`X-Hub-Signature: sha256=...`).
- [ ] Temporarily point the webhook at an unreachable URL, send a message,
      then `curl /api/instance/webhook/failures` — confirm the failure was logged
      with 4 attempts.

### 3. Security

- [ ] `HUB_TOKEN` and `WEBHOOK_SECRET` are both ≥ 32 hex chars (`openssl rand -hex 32`).
- [ ] `.env` is mode 600 and owned by `wahub:wahub`.
- [ ] `ufw status` blocks `:3060` and `:3061` from the public internet — only
      Cloudflare Tunnel (or your nginx reverse proxy) reaches the Hub.
- [ ] No `HUB_TOKEN` substring appears in `journalctl -u wa-hub --since "1h ago"`.

### 4. Resilience

- [ ] `systemctl restart wa-hub` → reconnects to WhatsApp within 30 s without
      a fresh QR.
- [ ] `systemctl stop wa-hub` → graceful shutdown in journal (`drained N pending`).
- [ ] After 1 h of idle, `journalctl -u wa-hub | grep heartbeat | tail` shows
      memory RSS staying flat (no leak).

### 5. Observability

- [ ] `journalctl -u wa-hub -f` shows structured per-request log lines
      (`m=POST p=/api/... s=200 ms=...`).
- [ ] On every webhook attempt, you see `webhook delivered` (or
      `webhook attempt failed`) lines with `attempt=N` and `ms=...`.

## Roadmap

- [ ] Persistent message store (currently in-memory only)
- [ ] Pluggable storage backends (SQLite, Postgres)
- [ ] Multi-tenant mode (one Hub managing many numbers)
- [ ] Built-in nginx config + Let's Encrypt setup
- [ ] Docker image
- [ ] Prometheus metrics endpoint

PRs welcome.

## Disclaimer & Acceptable Use

> **AS IS, no warranty.** This is an independent open-source project built on the unofficial, reverse-engineered Baileys library. **It is not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta Platforms, Inc.** Using an unofficial WhatsApp client may violate WhatsApp's Terms of Service, and Meta may rate-limit or permanently ban accounts — especially for bulk or unsolicited messaging.
>
> **You are solely responsible for using this software lawfully.** Only message people who have given you prior opt-in consent. You — not the author — must comply with all applicable laws (GDPR, CAN-SPAM, TCPA, Israel's §30A "Spam Law", and any local anti-spam/privacy rules) and obtain any required consent. The author accepts no liability for account bans, data loss, service interruption, or any legal consequence arising from your use. For commercial / high-volume messaging, use the official [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/). See **[DISCLAIMER.md](DISCLAIMER.md)**.

## License

[MIT](LICENSE) © 2026 Noam Nissan

## Acknowledgements

- [@WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — the heart of this project. Without it, none of this is possible. (Baileys is an **unofficial, reverse-engineered** implementation of the WhatsApp Web protocol, MIT-licensed — relying on it is what creates the Terms-of-Service and ban risk described in the [disclaimer](DISCLAIMER.md).)
