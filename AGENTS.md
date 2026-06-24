# AGENTS.md — for AI coding agents (Claude Code, Cursor, Base44, Copilot…)

You are integrating **wa-hub-demo**, a self-hosted **WhatsApp HTTP API** (REST + JSON + webhooks).
**To integrate, read [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — it is the single source of truth.**
([`openapi.yaml`](openapi.yaml) is the machine-readable spec; [`docs/API.md`](docs/API.md) is the exhaustive reference.)

## 60-second model (verified against `src/`)

- **Base URL** = the public tunnel URL (`https://<random>.trycloudflare.com`, **ephemeral** — changes on
  every restart) or a stable subdomain (`https://wa.yourdomain.com`), or `http://127.0.0.1:3060` on the box.
- **Auth** = header `Authorization: Bearer <HUB_TOKEN>` on **every** `/api/*` call.
- **Hard precondition — a WhatsApp device must be PAIRED once** (a human scans a QR at `GET /pair`). Until
  then, send routes return `503 {"error":"not_connected"}`. Gate sending on:
  `GET /api/instance/status` → `connection` must be `"connected"`.
- **Two secrets:**
  - `HUB_TOKEN` — **you → Hub**: the Bearer token above.
  - `WEBHOOK_SECRET` — **Hub → you**: every webhook body is signed `x-hub-signature: sha256=HMAC_SHA256(WEBHOOK_SECRET, rawBody)`. Verify it over the **raw** body before trusting a delivery.
  - (Optional `ADMIN_TOKEN`: if set, `POST /api/instance/logout` and `PUT /api/instance/webhook` also need `X-Admin-Token`.)
- Secrets live in `/srv/wa-hub-demo/.env` (mode 600). Never put `HUB_TOKEN` in frontend/client code — call the API from a **backend** function.

## Canonical call

```bash
curl -X POST "$BASE_URL/api/messages/send/text" \
  -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"972501234567","text":"hello"}'
# → 200 { "ok": true, "id": "...", "to": "...@s.whatsapp.net" }
```

`to` = international digits, no leading `0` (Israeli `058…` → `97258…`). Other sends:
`/send/image|file|audio|location|reaction`, `/markRead`. Lists/manages groups under `/api/groups`.
Check numbers: `POST /api/check/number`. Receive: `PUT /api/instance/webhook {url,events}`.

## Error codes

`401` bad/missing token · `403` needs `X-Admin-Token` · `413` media >20 MB · `429` rate-limited
(120/min/IP) · `503` `not_connected` (not paired yet). All errors are JSON `{error,message}`.

## Where to look

| Need | File |
|---|---|
| **How to integrate (start here)** | [`docs/INTEGRATION.md`](docs/INTEGRATION.md) (· [עברית](docs/INTEGRATION.he.md)) |
| Machine-readable API spec | [`openapi.yaml`](openapi.yaml) |
| Exhaustive endpoint reference | [`docs/API.md`](docs/API.md) |
| Reference webhook receiver | [`examples/base44/webhook-receiver.ts`](examples/base44/webhook-receiver.ts) |
| curl recipes | [`examples/curl/`](examples/curl/) |
| Stable production URL | [`docs/SUBDOMAIN.md`](docs/SUBDOMAIN.md) |

**Do NOT read these to integrate** (they are for the human who *operates* the server, not the developer
who *calls* the API): `docs/BUILD_GUIDE_*`, `docs/slides/`, `webinar/`, `deploy/`, `docs/DEPLOY.md`,
`docs/ARCHITECTURE.md`.

## Legal

Unofficial WhatsApp client (Baileys); may violate WhatsApp's ToS; message only consenting recipients.
See [`DISCLAIMER.md`](DISCLAIMER.md).
