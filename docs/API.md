# wa-hub-demo — API Reference

Endpoint-by-endpoint reference for the Hub's REST API and outbound webhook/WebSocket.
Everything is plain **REST + JSON + Bearer auth**. Generated from the source in `src/`.

- **Base URL:** your tunnel URL (e.g. `https://api.example.com`) or `http://127.0.0.1:3060` on the box.
- **WebSocket:** `:3061` (see [WebSocket](#websocket) below).

---

## Authentication

Every route under `/api/*` requires the Hub token via the header:

```
Authorization: Bearer <HUB_TOKEN>
```

The `?token=<HUB_TOKEN>` query form is **disabled by default** (query strings leak
into proxy/access logs and browser history). Enable it only if you must, with
`ALLOW_QUERY_TOKEN=true`. The WebSocket accepts the token via the `Authorization`
header too (preferred), or `?token=` as a fallback.

- Comparison is constant-time and leaks no length (`src/auth.js`, `src/security/compare.js`).
- Missing/invalid token → `401 { "error": "unauthorized" }`.
- Rate limit: `RATE_LIMIT_PER_MIN` (default **120**/min **per client IP**). Exceeding it → `429 { "error": "rate_limited" }`. Set `RATE_LIMIT_PER_MIN=0` to disable. Behind a tunnel/proxy set `TRUST_PROXY=true` so the limiter keys on the real caller, not the proxy.
- **Admin routes.** When `ADMIN_TOKEN` is set, `POST /api/instance/logout` and `PUT /api/instance/webhook` additionally require an `X-Admin-Token: <ADMIN_TOKEN>` header.
- **Outbound egress (webhook + media URLs).** `http(s)` only, and private/loopback/link-local targets (incl. `169.254.169.254`) are refused to prevent SSRF. Override with `ALLOW_PRIVATE_EGRESS=true` if your receiver is on a private network.

**Open** endpoints (no token): `GET /healthz` (returns just `{ "ok": true, "connection": "..." }`)
and `GET /pair` (a live pairing page — see [Pairing](#pairing) below; the page itself is public but
carries no secret and fetches the token-gated QR with a token you supply in the browser).

### Pairing

Open **`<base-url>/pair`** in a browser. Paste your `HUB_TOKEN` when asked (or open
`<base-url>/pair#<HUB_TOKEN>` — the `#fragment` is never sent to the server/logs). The page shows the
QR, **refreshes it automatically** (~every 20 s) and flips to “Linked” the moment you scan it from
WhatsApp → Settings → Linked Devices → Link a Device. Headless alternative: `GET /api/instance/qr.png`
(token required) or the `GET /api/instance/qr` JSON.

### Recipient (`to`) formats accepted

| Form | Example |
|---|---|
| E.164 with `+` | `+972501234567` |
| Bare digits (7–15) | `972501234567` |
| Full user JID | `972501234567@s.whatsapp.net` |
| Group JID (15+ digits) | `120363042xxxxxxx@g.us` |
| WhatsApp logical id | `8362502693023@lid` |

Bare digits are normalized to `…@s.whatsapp.net`. Use country code without a leading `0`
(Israeli `0585802298` → `972585802298`).

---

## Health

### `GET /healthz` — *(open, no auth)*

```json
{
  "ok": true,
  "name": "wa-hub",
  "version": "0.1.0",
  "connection": "connected",
  "qr": false,
  "webhookConfigured": true,
  "pendingDeliveries": 0,
  "recentErrors": 0,
  "recentWebhookFailures": 0,
  "uptimeMs": 123456
}
```

`connection` is one of `disconnected` | `connecting` | `qr` | `connected`. Use this for uptime monitors.

---

## Messages — `/api/messages`

All send routes return `503 { "error": "not_connected" }` if WhatsApp isn't paired/connected yet.
Media may be supplied as a public `…Url` **or** base64 `…Base64` (max **20 MB decoded**; oversize → `413`/`file_too_large`).

### `POST /api/messages/send/text`
```json
{ "to": "972501234567", "text": "hello", "quotedMessageId": "<optional msg id>" }
```
→ `{ "ok": true, "id": "3EB0...", "to": "972501234567@s.whatsapp.net", "timestamp": 1730000000000 }`
`text`: 1–4096 chars.

### `POST /api/messages/send/image`
```json
{ "to": "972501234567", "imageUrl": "https://...", "caption": "optional ≤1024" }
```
(or `"imageBase64": "<base64 or data: URL>"`) → `{ "ok": true, "id": "...", "to": "..." }`

### `POST /api/messages/send/file`
```json
{ "to": "972501234567", "fileUrl": "https://...", "filename": "report.pdf",
  "mimetype": "application/pdf", "caption": "optional" }
```
(or `fileBase64`) · `filename` 1–255, `mimetype` defaults to `application/octet-stream`.

### `POST /api/messages/send/audio`
```json
{ "to": "972501234567", "audioUrl": "https://...", "ptt": true }
```
(or `audioBase64`) · `ptt` (voice note) defaults `true`. Sent as `audio/ogg; codecs=opus`.

### `POST /api/messages/send/location`
```json
{ "to": "972501234567", "latitude": 32.08, "longitude": 34.78,
  "name": "Tel Aviv", "address": "optional" }
```

### `POST /api/messages/send/reaction`
```json
{ "to": "972501234567", "messageId": "<msg id>", "emoji": "👍", "fromMe": false }
```
Empty `emoji` removes a reaction. → `{ "ok": true, "id": "..." }`

### `POST /api/messages/markRead`
```json
{ "to": "972501234567", "messageId": "<msg id>", "fromMe": false }
```
→ `{ "ok": true }`

---

## Instance — `/api/instance`

### `GET /api/instance/status`
```json
{ "name": "wa-hub", "connection": "connected",
  "me": { "jid": "...", "number": "972...", "name": "..." },
  "startedAt": 1730000000000, "uptimeMs": 123456, "lastEventAt": 1730000000000,
  "webhook": { "url": "https://...", "events": ["message.incoming"] } }
```

### `GET /api/instance/qr`
`{ "dataUrl": "data:image/png;base64,...", "expiresAt": 1730000060000 }`
· `409 already_paired` if connected · `404 no_qr` if none staged yet (retry in a few seconds).

### `GET /api/instance/qr.png`
Renders the current QR as a PNG (open in a browser). `404` (empty body) if no QR — fetch with `curl -fsS` so a 404 doesn't write a 0-byte file.

### `GET /api/instance/webhook`  /  `PUT /api/instance/webhook`
GET returns `{ "url", "events" }`. PUT sets it:
```json
{ "url": "https://your-receiver/wa", "events": ["message.incoming", "message.outgoing"] }
```
`events: []` (or omitted) delivers **all** events. **Persisted to `data/webhook.json`** — survives restart and **takes precedence over** the `.env` `WEBHOOK_URL`/`WEBHOOK_EVENTS` defaults. `url: null` clears it.

### `GET /api/instance/webhook/failures`
Last ≤100 delivery failures (disk-backed): `{ "count", "failures": [ { event, url, attempts, lastStatus, lastError, totalMs } ] }`.

### `GET /api/instance/errors`
Last ≤50 route/unhandled errors (in-memory): `{ "count", "errors": [ ... ] }`.

### `GET /api/instance/diagnose`
Runs a small self-test battery (socket open? webhook reachable? public probe) and returns a structured JSON. ~6 s worst case.

### `POST /api/instance/logout`
Wipes `data/auth`, restarts Baileys, and a fresh QR appears shortly. → `{ "ok": true, "message": "..." }`

---

## Groups — `/api/groups`

### `GET /api/groups`
```json
{ "count": 2, "groups": [ { "jid": "...@g.us", "name": "Team", "participants": 12,
  "owner": "...", "creation": 1700000000000, "announce": false } ] }
```

### `GET /api/groups/:jid`
Full Baileys group metadata. `:jid` may be the bare 15+ digit id or `…@g.us`.

### `POST /api/groups/:jid/participants`
```json
{ "add": ["972..."], "remove": ["972..."], "promote": ["972..."], "demote": ["972..."] }
```
Each list ≤50. → `{ "ok": true, "results": { ... } }`

---

## Check — `/api/check`

### `POST /api/check/number`
```json
{ "numbers": ["972501234567", "972500000000"] }
```
1–50 numbers. → `{ "results": [ { "input": "972501234567", "exists": true, "jid": "...@s.whatsapp.net" } ] }`
Useful to confirm a recipient exists on WhatsApp before sending.

---

## Outbound webhook

When a webhook URL is set, the Hub POSTs JSON to it on every (subscribed) event.

**Headers:**
| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-hub-signature` | `sha256=<HMAC-SHA256(WEBHOOK_SECRET, rawBody)>` |
| `x-hub-event` | the event name |
| `x-hub-timestamp` | epoch-ms the payload was generated (verify it's recent to reject replays) |
| `x-hub-delivery` | unique id per delivery; stable across this delivery's retries (dedup on it) |
| `user-agent` | `wa-hub-demo/<HUB_NAME>` |

> Verify the signature, **and** reject deliveries whose `x-hub-timestamp` is stale (e.g. >5 min skew)
> and dedup on `x-hub-delivery` — see `examples/base44/webhook-receiver.ts` for a reference receiver.

**Body:**
```json
{ "event": "message.incoming", "timestamp": 1730000000000, "instance": "wa-hub", "data": { ... } }
```

**Verify the signature** over the *raw* body before trusting it (see `examples/base44/webhook-receiver.ts`).

**Retries:** up to 4 attempts — immediate, +2 s, +6 s, +18 s — **only** on `5xx`, `408`, `429`, or network errors. Any other `4xx` aborts immediately (logged to `webhook-failures.json`).

### Events

| Event | When |
|---|---|
| `message.incoming` | a message arrived |
| `message.outgoing` | you sent a message (incl. from the phone) |
| `message.status` | delivery/read receipt changed |
| `instance.connected` | WhatsApp connected |
| `instance.disconnected` | connection dropped |
| `instance.qr` | a new QR was generated (the QR itself is **never** sent over webhook) |

### `data` for `message.incoming` / `message.outgoing`
```json
{
  "id": "3EB0...",
  "timestamp": 1730000000000,
  "chat": "972...@s.whatsapp.net",
  "chatAlt": null,
  "isGroup": false,
  "from": "972...@s.whatsapp.net",
  "fromMe": false,
  "fromNumber": "972501234567",
  "fromLid": false,
  "fromName": "Dana",
  "type": "text",
  "text": "hi",
  "media": null,
  "quoted": null
}
```
`type` ∈ `text|image|video|audio|document|sticker|location|contact|reaction|poll|unknown`.
On the **LID** rollout, `fromNumber` may itself be a logical id when WhatsApp hides the phone; `fromLid:true` flags it. Identify such chats by the stable `chat` JID.

### `data` for `message.status`
```json
{ "id": "3EB0...", "chat": "972...@s.whatsapp.net", "fromMe": true, "status": "read", "statusCode": 4 }
```
`status` ∈ `error|pending|sent|delivered|read|played` (✓ = sent, ✓✓ = delivered, ✓✓ blue = read).

---

## WebSocket

Real-time event stream on `:3061`. Bound to **loopback by default** (`WS_HOST=127.0.0.1`)
— set `WS_HOST=0.0.0.0` (and open the port / tunnel it) to reach it remotely.

Authenticate with the `Authorization: Bearer <HUB_TOKEN>` header (preferred), or the
`?token=` query fallback where the header is awkward:

```
ws://<host>:3061/            Authorization: Bearer <HUB_TOKEN>
ws://<host>:3061/?token=<HUB_TOKEN>
```

First frame on connect:
```json
{ "event": "hello", "data": { "connection": "connected", "me": { ... } } }
```
Then one frame per event:
```json
{ "event": "message.incoming", "timestamp": 1730000000000, "data": { ... } }
```
(No `instance` field, unlike the webhook.) Bad/absent token → the socket closes with code `4001`;
a forbidden `Origin` (when `WS_ALLOWED_ORIGINS` is set) → `4003`; over `WS_MAX_CLIENTS` → `1013`.

> ⚠️ Prefer the `Authorization` header. If you use `?token=`, the token leaks into proxy/browser
> logs — use a dedicated token for dashboards and serve the WS only behind the encrypted tunnel.
> The stream carries full message **content** to every authenticated client, so treat the token as
> sensitive and restrict `WS_ALLOWED_ORIGINS` for browser dashboards.

---

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [DEPLOY.md](DEPLOY.md) · [BUILD_GUIDE_HE.md](BUILD_GUIDE_HE.md) (full Hebrew walkthrough).
