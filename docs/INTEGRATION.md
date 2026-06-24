<!-- עברית למטה ⬇  ·  Hebrew version below ⬇  (docs/INTEGRATION.he.md) -->

# wa-hub-demo — Integration Guide

**Hand this document to a developer, to Base44, or to an AI coding agent (Claude Code / Cursor). It is
everything needed to use this WhatsApp API correctly.**

`wa-hub-demo` is a **self-hosted WhatsApp HTTP API**. It runs on your own server and bridges to WhatsApp
through a **linked device** (exactly like WhatsApp Web). You drive it with plain **REST + JSON**, and you
receive incoming messages/events through **webhooks** (or a WebSocket). It is *not* the official WhatsApp
Business API — it is an unofficial client (Baileys). See the legal note at the end.

---

## ⚡ TL;DR (read this first)

```
BASE_URL   = your tunnel URL (https://<random>.trycloudflare.com) or your subdomain (https://wa.yourdomain.com)
AUTH       = header  Authorization: Bearer <HUB_TOKEN>     on every /api/* call
PRECONDITION = a WhatsApp device must be PAIRED once (scan a QR) before sending works
SEND TEXT  = POST <BASE_URL>/api/messages/send/text   {"to":"972501234567","text":"hi"}
RECEIVE    = set a webhook (PUT /api/instance/webhook); the Hub POSTs events to your URL,
             signed with HMAC-SHA256 using <WEBHOOK_SECRET> (header x-hub-signature) — verify it.
NOT CONNECTED yet → sends return 503 {"error":"not_connected"}.  Bad token → 401.  Too many → 429.
```

There are **two concepts** you must understand before writing code: **(1) pairing** and **(2) the two
secrets**. They are explained next.

---

## 1. Concept #1 — Pairing (linking a WhatsApp device), one time

The Hub cannot send or receive anything until a **real WhatsApp account is linked to it**, the same way
you link WhatsApp Web/Desktop. This is a **one-time, human step** (someone scans a QR with the phone).

**How to pair:**
1. Open **`<BASE_URL>/pair`** in a browser.
2. Paste the `HUB_TOKEN` when asked (or open `<BASE_URL>/pair#<HUB_TOKEN>` — the part after `#` stays in
   your browser and is never sent to the server).
3. On the phone: **WhatsApp → Settings → Linked Devices → Link a Device**, scan the QR.
4. The page flips to a **console** (a "send test" button, ready-made API examples, webhook setup).

**Important properties:**
- The session is saved on the server (`data/auth/`). It survives restarts — you pair **once**.
- If the **primary phone is offline for ~14 days**, WhatsApp unlinks all devices and you must re-pair.
- To force a re-pair: `POST /api/instance/logout`, then reload `/pair`.
- **Check the state in code before sending:**
  ```
  GET <BASE_URL>/api/instance/status   →   { "connection": "connected", "me": {...}, ... }
  ```
  `connection` is one of `disconnected` | `connecting` | `qr` | `connected`. **Only send when it is
  `connected`.** Every send endpoint returns `503 {"error":"not_connected"}` otherwise.

---

## 2. Concept #2 — The two secrets ("2 passwords")

There are **two independent secrets**, pointing in **opposite directions**:

| Secret | Direction | What it protects | How it's used |
|---|---|---|---|
| **`HUB_TOKEN`** | **You → Hub** | your calls *to* the API | Header `Authorization: Bearer <HUB_TOKEN>` on **every** `/api/*` request (and the WebSocket). |
| **`WEBHOOK_SECRET`** | **Hub → You** | events the Hub sends *to* you | The Hub signs every webhook body with HMAC-SHA256 using this key; you verify the `x-hub-signature` header to be sure the call is genuinely from your Hub. |

> Think of `HUB_TOKEN` as the **password to control WhatsApp**, and `WEBHOOK_SECRET` as the **password
> that proves an incoming webhook is really from your Hub** (not a forgery hitting your endpoint).

**Optional third secret — `ADMIN_TOKEN`:** if it is set, the *destructive/config* routes
(`POST /api/instance/logout` and `PUT /api/instance/webhook`) additionally require an
`X-Admin-Token: <ADMIN_TOKEN>` header. This lets you give out the `HUB_TOKEN` for sending/reading while
keeping logout/webhook-changes behind a separate key. If `ADMIN_TOKEN` is unset, only `HUB_TOKEN` is needed.

**Where the secrets live:** generated at install, stored in `/srv/wa-hub-demo/.env` (mode `600`, owner
`wahub`). Reveal them on the server with:
```bash
sudo grep -E '^(HUB_TOKEN|WEBHOOK_SECRET)=' /srv/wa-hub-demo/.env
```
Keep them in a password manager. **To rotate:** edit `.env` → `sudo systemctl restart wa-hub` → update consumers.

---

## 3. Base URL

The API base URL is whatever exposes the Hub to the internet:

- **Quick Tunnel** (the default the installer sets up): `https://<random>.trycloudflare.com`.
  ⚠️ **This URL is temporary — it changes every time the tunnel restarts (reboot/crash/update).** Fine
  for testing; **do not** hard-code it for production.
- **Named Tunnel on your subdomain** (recommended for real use): `https://wa.yourdomain.com` — **stable**,
  survives restarts. Setup guide: **[SUBDOMAIN.md](SUBDOMAIN.md)**.
- **On the server itself:** `http://127.0.0.1:3060`.

All endpoint paths below are **relative to the base URL**.

---

## 4. Authentication (on every request)

```
Authorization: Bearer <HUB_TOKEN>
```

- Missing/invalid token → **`401 {"error":"unauthorized"}`**.
- Not paired yet → **`503 {"error":"not_connected"}`** (on send routes).
- Rate limit: **120 requests/min per client IP** by default → **`429 {"error":"rate_limited"}`**.
- The `?token=` query form is **off by default** (it leaks into logs); always prefer the header.
- **Open** routes that need no token: `GET /healthz` and `GET /pair`.

---

## 5. Quickstart (copy-paste)

```bash
BASE="https://wa.yourdomain.com"        # or your trycloudflare URL
TOKEN="<HUB_TOKEN>"

# 1) Is it paired and ready?
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/instance/status"

# 2) Send a text message
curl -s -X POST "$BASE/api/messages/send/text" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"972501234567","text":"hello from wa-hub"}'

# 3) Is a number on WhatsApp?
curl -s -X POST "$BASE/api/check/number" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"numbers":["972501234567"]}'

# 4) Receive incoming messages — point the Hub at your webhook
curl -s -X PUT "$BASE/api/instance/webhook" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://your-server.com/wa-hook","events":["message.incoming"]}'
```

---

## 6. Endpoint reference (the ones you'll use most)

> Recipient (`to`) accepts: `+972501234567`, `972501234567` (bare digits, normalized to
> `…@s.whatsapp.net`), `972501234567@s.whatsapp.net`, a group `…@g.us`, or a `…@lid`. Use the country
> code **without** a leading `0` (Israeli `058…` → `97258…`).

### Send messages — `POST /api/messages/...`  *(require `connected`)*
| Route | Body | Notes |
|---|---|---|
| `/send/text` | `{ "to", "text", "quotedMessageId?" }` | `text` 1–4096 chars |
| `/send/image` | `{ "to", "imageUrl"｜"imageBase64", "caption?" }` | media ≤20 MB |
| `/send/file` | `{ "to", "fileUrl"｜"fileBase64", "filename", "mimetype?", "caption?" }` | any document |
| `/send/audio` | `{ "to", "audioUrl"｜"audioBase64", "ptt?" }` | `ptt:true` = voice note |
| `/send/location` | `{ "to", "latitude", "longitude", "name?", "address?" }` | |
| `/send/reaction` | `{ "to", "messageId", "emoji", "fromMe?" }` | empty `emoji` removes it |
| `/markRead` | `{ "to", "messageId", "fromMe?" }` | mark as read |

Media: supply a **public URL** (`...Url`) *or* **base64** (`...Base64`, may be a `data:` URL). Max **20 MB**
decoded → otherwise `413 file_too_large`. Send routes return `{ "ok": true, "id": "<msgId>", "to": "<jid>" }`.

### Check — `POST /api/check/number`
`{ "numbers": ["972501234567", ...] }` (1–50) → `{ "results": [ { "input", "exists", "jid" } ] }`. Use it
to confirm a recipient exists on WhatsApp before sending.

### Groups — `/api/groups`
- `GET /api/groups` → `{ "count", "groups": [ { jid, name, participants, owner, creation, announce } ] }`
- `GET /api/groups/:jid` → full group metadata (`:jid` = the 15+ digit id or `…@g.us`)
- `POST /api/groups/:jid/participants` → `{ "add?", "remove?", "promote?", "demote?" }` (each list ≤50)

### Instance — `/api/instance`
- `GET /status` → connection state + paired account + webhook config (poll this; gate sends on `connected`)
- `GET /qr` → `{ "dataUrl", "expiresAt" }` · `409 already_paired` · `404 no_qr` (retry shortly)
- `GET /qr.png` → the QR as a PNG (open in a browser; fetch with `curl -fsS`)
- `GET /diagnose` → self-test JSON (socket / internet / env / webhook)
- `POST /smoketest` → sends a confirmation message to the paired number (the console's "Send test" button)
- `GET /webhook` · `PUT /webhook` → read/set the webhook (see §7)
- `GET /webhook/failures` · `GET /errors` → recent delivery failures / route errors
- `POST /logout` → unlink the device and start a fresh QR

*(Full endpoint-by-endpoint reference with every field: [API.md](API.md).)*

---

## 7. Receiving messages — Webhooks

Set your receiver once; the Hub then **POSTs JSON to it on every (subscribed) event**:
```bash
curl -X PUT "$BASE/api/instance/webhook" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://your-server.com/wa-hook","events":["message.incoming"]}'
```
- `events: []` (or omitted) delivers **all** events. The config is **persisted** (survives restarts) and
  overrides the `.env` defaults. `url: null` disables it.

**Events:** `message.incoming`, `message.outgoing`, `message.status`, `instance.connected`,
`instance.disconnected`, `instance.qr` (the QR image itself is never sent).

**Request the Hub sends to you:**
| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-hub-signature` | `sha256=<HMAC-SHA256(WEBHOOK_SECRET, rawBody)>` |
| `x-hub-event` | the event name |
| `x-hub-timestamp` | epoch-ms (reject if stale, e.g. >5 min — replay protection) |
| `x-hub-delivery` | unique id per delivery, stable across retries (dedupe on it) |

**Body:**
```json
{ "event": "message.incoming", "timestamp": 1730000000000, "instance": "wa-hub", "data": { ... } }
```

**`data` for `message.incoming` / `message.outgoing`:**
```json
{
  "id": "3EB0...", "timestamp": 1730000000000,
  "chat": "972...@s.whatsapp.net", "chatAlt": null, "isGroup": false,
  "from": "972...@s.whatsapp.net", "fromMe": false,
  "fromNumber": "972501234567", "fromLid": false, "fromName": "Dana",
  "type": "text", "text": "hi", "media": null, "quoted": null
}
```
`type` ∈ `text|image|video|audio|document|sticker|location|contact|reaction|poll|unknown`. For media
types, `text` is the caption and `media` holds `{ kind, mimetype, fileLength, ... }` (the Hub does **not**
download the media; fetch it yourself if needed). On WhatsApp's **LID** rollout `fromNumber` may itself be
a logical id — `fromLid:true` flags it; the stable identifier is `chat`.

**`data` for `message.status`:** `{ "id", "chat", "fromMe", "status", "statusCode" }` where `status` ∈
`error|pending|sent|delivered|read|played`.

### ⚠️ Verify the signature (do this — it's the whole point of `WEBHOOK_SECRET`)

Compute the HMAC over the **raw request body** (before JSON parsing) and compare to `x-hub-signature`:

**Node.js (Express):**
```js
import crypto from 'crypto';
import express from 'express';
const app = express();

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header || ''), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Capture the RAW body so the signature matches byte-for-byte.
app.post('/wa-hook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body, req.get('x-hub-signature'), process.env.WEBHOOK_SECRET)) {
    return res.status(401).end();            // reject forgeries
  }
  const payload = JSON.parse(req.body.toString('utf8'));
  // ... handle payload.event / payload.data ...
  res.sendStatus(200);                        // ack quickly (2xx)
});
```

**Python (Flask):**
```python
import hmac, hashlib
from flask import Flask, request, abort
app = Flask(__name__)

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header or "", expected)

@app.post("/wa-hook")
def hook():
    if not verify(request.get_data(), request.headers.get("x-hub-signature", ""),
                  os.environ["WEBHOOK_SECRET"]):
        abort(401)
    payload = request.get_json()
    # ... handle payload["event"] / payload["data"] ...
    return "", 200
```

**Reply `2xx` quickly.** Retries: up to 4 attempts (immediate, +2 s, +6 s, +18 s) **only** on `5xx`,
`408`, `429`, or a network error — any other `4xx` aborts and is logged to `webhook-failures.json`.

---

## 8. WebSocket (optional, real-time)

A read-only event stream on port **`3061`** (loopback by default — tunnel it or set `WS_HOST=0.0.0.0` to
reach remotely). Auth with the same token:
```
ws://<host>:3061/        header  Authorization: Bearer <HUB_TOKEN>
```
First frame: `{ "event": "hello", "data": { "connection", "me" } }`, then one frame per event
`{ "event", "timestamp", "data" }`. Bad token closes with code `4001`. The stream carries full message
content, so treat the token as sensitive. (For most integrations, **webhooks are simpler and recommended**.)

---

## 9. Errors & limits

| Status | Meaning |
|---|---|
| `200` | OK |
| `400` | `invalid_body` / `invalid_json` — bad request shape (check `issues`) |
| `401` | `unauthorized` — missing/invalid `HUB_TOKEN` |
| `403` | `forbidden` — needs `X-Admin-Token` (when `ADMIN_TOKEN` is set) |
| `404` | `not_found` / `no_qr` |
| `409` | `already_paired` (on `/qr`) |
| `413` | `file_too_large` / `payload_too_large` (media >20 MB) |
| `429` | `rate_limited` (default 120/min/IP) |
| `503` | `not_connected` (not paired) or `unavailable` (overloaded) |

All errors are JSON: `{ "error": "<code>", "message": "<human text>" }`.

---

## 10. Security checklist

- Keep `HUB_TOKEN` + `WEBHOOK_SECRET` secret (they are passwords). Never commit them; never log them.
- The full `/pair#<token>` link contains your token — treat that link as a secret too.
- Always **verify the webhook signature** over the raw body, and reject stale `x-hub-timestamp`.
- Prefer a **stable subdomain** ([SUBDOMAIN.md](SUBDOMAIN.md)) for anything ongoing.
- The Hub blocks outbound requests to private/loopback/metadata IPs (anti-SSRF) unless you set
  `ALLOW_PRIVATE_EGRESS=true`.

---

## 11. Paste-ready brief for an AI agent (Base44 / Claude Code)

> You are integrating **wa-hub-demo**, a self-hosted WhatsApp HTTP API.
> - Base URL: `<BASE_URL>`. Auth: header `Authorization: Bearer <HUB_TOKEN>` on every `/api/*` call.
> - Precondition: a WhatsApp device must already be paired; `GET /api/instance/status` must return
>   `connection:"connected"` before sending, else sends return `503 not_connected`.
> - Send a text: `POST /api/messages/send/text` with `{"to":"<E164-no-plus>","text":"..."}` →
>   `{ok:true,id,to}`. Other sends: `/send/image|file|audio|location|reaction`, `/markRead`.
> - Check a number: `POST /api/check/number {"numbers":[...]}`.
> - Receive messages: set `PUT /api/instance/webhook {"url":"<your-url>","events":["message.incoming"]}`.
>   The Hub POSTs `{event,timestamp,instance,data}`; verify header `x-hub-signature: sha256=HMAC_SHA256(<WEBHOOK_SECRET>, rawBody)`
>   over the raw body before trusting it; reply 2xx fast.
> - Errors are JSON `{error,message}`; 401=bad token, 429=rate limited (120/min/IP), 503=not paired.
> - Fill in `<BASE_URL>`, `<HUB_TOKEN>`, `<WEBHOOK_SECRET>` from the operator (in `/srv/wa-hub-demo/.env`).

---

## Legal / ToS

This is an **unofficial** WhatsApp client (Baileys), not affiliated with WhatsApp/Meta, and may violate
their Terms of Service. You are solely responsible for messaging only consenting recipients and for
complying with GDPR / CAN-SPAM / TCPA / local anti-spam law. No warranty. See
[../DISCLAIMER.md](../DISCLAIMER.md).

---

*Hebrew version: [INTEGRATION.he.md](INTEGRATION.he.md) · Full API reference: [API.md](API.md) ·
Stable subdomain: [SUBDOMAIN.md](SUBDOMAIN.md) · Deploy notes: [DEPLOY.md](DEPLOY.md).*
