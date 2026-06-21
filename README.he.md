<div dir="rtl" align="right">

# wa-hub-demo

> **WhatsApp HTTP API שמתארח אצלך. בסגנון Green-API — אבל לגמרי שלך.**
> Node 20 + [Baileys](https://github.com/WhiskeySockets/Baileys). מספר יחיד (single-tenant).
> נבנה עבור הוובינר *"איך לשגר בוט WhatsApp ב-45 דקות"* — אבל ברמת פרודקשן.

**🌐 שפה:** [English](README.md) · **עברית**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()
[![Baileys](https://img.shields.io/badge/baileys-7.0.0--rc13-blue)]()

---

## מה מקבלים

שכבת REST + WebSocket + webhooks-יוצאים מעל WhatsApp Web — נקייה, מאומתת,
עם rate-limit, חתומה ב-HMAC, ומוכנה לרוץ על כל VPS לינוקס ב-€4 לחודש.

```
┌──────────────┐    ┌──────────────────────────────┐    ┌──────────────┐
│  WhatsApp    │ ←→ │  wa-hub-demo                 │ ←→ │  האפליקציה   │
│  (טלפון      │    │  ├─ Baileys (פרוטוקול WA)    │    │  שלך         │
│   מצומד)     │    │  ├─ REST :3060               │    │  (Base44,    │
│              │    │  ├─ WebSocket :3061          │    │   n8n, Make, │
│              │    │  └─ Webhooks חתומים (HMAC)   │    │   כל דבר)    │
└──────────────┘    └──────────────────────────────┘    └──────────────┘
```

## למה?

| אירוח-עצמי (זה) | שירותים מנוהלים (Green-API, Wassenger…) |
|---|---|
| €3.79–€3.99 לחודש קבוע | $20–$200+ לחודש, לרוב לפי הודעה |
| ההודעות בבעלותך | הם מתווכים אותן |
| בלי rate-limit חיצוני | המגבלות שלהם |
| אתה מתחזק ומנטר | הם מתחזקים ומנטרים |

אם הנפח שלך בינוני **וגם** אכפת לך מעלות/פרטיות/שליטה — ארח בעצמך.
אם אתה צריך SLA של 99.99% בלי עבודת ops — שלם למישהו.

## התחלה מהירה

> 📘 **למדריך "קונים שרת → API חי תוך 45 דקות" צעד-אחר-צעד**,
> קראו את **[docs/BUILD_GUIDE_HE.md](docs/BUILD_GUIDE_HE.md)** (עברית, מלא).
> הוא מכסה רכישת VPS, הקשחת SSH, התקנה ידנית, פיירינג, Cloudflare Tunnel,
> ודוגמת אינטגרציה ל-Base44.

לחסרי-סבלנות — מקומית, רק כדי לבדוק:

```bash
git clone https://github.com/Noam13-w/wa-hub-demo.git
cd wa-hub-demo
cp .env.example .env
# ערכו את .env — קבעו HUB_TOKEN ו-WEBHOOK_SECRET למחרוזות אקראיות ארוכות
#   openssl rand -hex 32
npm install
npm start
```

ואז בטרמינל אחר:

```bash
# 1. שמרו את ה-QR כ-PNG ופתחו אותו
TOKEN=$(grep HUB_TOKEN .env | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:3060/api/instance/qr.png > qr.png
start qr.png   # או: open / xdg-open

# 2. סרקו מ-WhatsApp → הגדרות → מכשירים מקושרים

# 3. שלחו את ההודעה הראשונה
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"to":"+972501234567","text":"שלום, עולם!"}' \
     http://localhost:3060/api/messages/send/text
```

## ה-API במבט מהיר

כל ה-endpoints תחת `/api/*` דורשים `Authorization: Bearer <HUB_TOKEN>`.

| Method | Path | מה זה עושה |
|---|---|---|
| `GET`  | `/healthz` | בדיקת חיות (ללא auth). מחזיר `connection`, `qr`, `webhookConfigured`, `pendingDeliveries`, `recentErrors`, `version`, `uptimeMs` |
| `GET`  | `/api/instance/status` | מצב חיבור + פרטי המכשיר המצומד |
| `GET`  | `/api/instance/qr` | ה-QR הנוכחי (JSON, base64) |
| `GET`  | `/api/instance/qr.png` | ה-QR הנוכחי (PNG גולמי, נפתח בדפדפן) |
| `GET`  | `/api/instance/diagnose` | בדיקה עצמית: קישוריות אינטרנט, תיקיית auth, env, מצב socket |
| `POST` | `/api/instance/logout` | מחיקת auth, אילוץ פיירינג מחדש |
| `GET`/`PUT` | `/api/instance/webhook` | קריאה/הגדרה של webhook יוצא + סינון אירועים |
| `POST` | `/api/messages/send/text` | `{ to, text, quotedMessageId? }` |
| `POST` | `/api/messages/send/image` | `{ to, imageUrl\|imageBase64, caption? }` |
| `POST` | `/api/messages/send/file` | `{ to, fileUrl\|fileBase64, filename, mimetype? }` |
| `POST` | `/api/messages/send/audio` | `{ to, audioUrl\|audioBase64, ptt? }` |
| `POST` | `/api/messages/send/location` | `{ to, latitude, longitude, name?, address? }` |
| `POST` | `/api/messages/send/reaction` | `{ to, messageId, emoji }` |
| `POST` | `/api/check/number` | `{ numbers: [...] }` → אילו מהם רשומים ב-WhatsApp |
| `GET`  | `/api/groups` | רשימת כל הקבוצות שאתה חבר בהן |
| `POST` | `/api/groups/:jid/participants` | `{ add\|remove\|promote\|demote: [...] }` |

תיעוד מלא עם דוגמאות בקשה/תשובה: **[docs/API.md](docs/API.md)**

## אירועים נכנסים (מבנה ה-webhook)

כש-`instance.webhook.url` מוגדר, ה-Hub שולח POST עם JSON ל-URL הזה בכל אירוע,
חתום ב-HMAC-SHA256 בכותרת `X-Hub-Signature: sha256=<hex>` (אותה מוסכמה כמו
webhooks של GitHub).

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
    "type": "text",
    "text": "היי!",
    "media": null,
    "quoted": null
  }
}
```

**תמיד אמתו את החתימה** לפני שאתם סומכים על ה-payload — ראו את קטע האימות ב-
[examples/base44/webhook-receiver.ts](examples/base44/webhook-receiver.ts).

### סוגי אירועים

- `message.incoming` — הודעה שהתקבלה
- `message.outgoing` — הודעה שנשלחה (גם שליחות מהטלפון שלך)
- `message.status` — אישור מסירה (נשלח → נמסר → נקרא)
- `instance.connected` — מצומד ומחובר
- `instance.disconnected` — החיבור נפל (מתחבר מחדש אוטומטית)
- `instance.qr` — נוצר QR חדש (ה-QR עצמו **לא** נכלל ב-payload — משכו אותו מ-`/api/instance/qr` בערוץ המאובטח שלכם)

## מבנה הפרויקט

```
wa-hub-demo/
├── src/
│   ├── index.js              ← נקודת כניסה
│   ├── config.js             ← ולידציית env (zod)
│   ├── state.js              ← state יחיד + event bus
│   ├── webhook.js            ← שולח webhooks יוצאים (חתום)
│   ├── auth.js               ← middleware של Bearer + rate limit
│   ├── baileys/              ← מחזור חיים של Baileys + נירמול הודעות
│   ├── rest/                 ← אפליקציית Express + routers
│   └── ws/                   ← משדר WebSocket
├── deploy/                   ← systemd unit מוקשח + install.sh + Cloudflare Tunnel
├── docs/                     ← BUILD_GUIDE_HE + API + ARCHITECTURE + DEPLOY
└── examples/                 ← פונקציות Base44 + שורות curl להעתקה
```

## מודל אבטחה

- **Bearer auth** — בכל ה-endpoints תחת `/api/*`. ה-token מושווה ב-constant-time.
- **Webhooks חתומים ב-HMAC** — ה-payloads היוצאים נושאים `X-Hub-Signature`. אמתו אותו.
- **Loopback כברירת מחדל** — ה-listener מאזין ל-`0.0.0.0`, אבל `ufw` אמור לחסום את `:3060`
  מהאינטרנט. השתמשו ב-Cloudflare Tunnel (או nginx + Let's Encrypt + allowlist).
- **הקשחת systemd** — `NoNewPrivileges`, `ProtectSystem=strict`, `CapabilityBoundingSet=`,
  `MemoryMax=512M` ועוד.
- **Rate-limit** — לכל token, ניתן להגדרה (`RATE_LIMIT_PER_MIN`).
- **אין סודות בקוד** — הכל ב-`.env`, שנמצא ב-gitignore.

## הגדרות

ראו [`.env.example`](.env.example) לרשימה המלאה. המשתנים היחידים שחובה להגדיר:

| משתנה | תיאור |
|---|---|
| `HUB_TOKEN` | ה-Bearer token שהלקוחות שולחים. יצירה: `openssl rand -hex 32` |
| `WEBHOOK_SECRET` | סוד ה-HMAC לחתימת webhooks. יצירה: `openssl rand -hex 32` |

לכל השאר יש ברירות מחדל הגיוניות.

## דוגמאות

- [`examples/base44/send-message.ts`](examples/base44/send-message.ts) — פונקציית Base44 ששולחת הודעה דרך ה-Hub
- [`examples/base44/webhook-receiver.ts`](examples/base44/webhook-receiver.ts) — פונקציית Base44 שמקבלת הודעות נכנסות (עם אימות חתימה)
- [`examples/curl/`](examples/curl/) — שורות shell לכל endpoint

## צעדים הבאים (Roadmap)

ראו [docs/ROADMAP.md](docs/ROADMAP.md) — אחסון הודעות מתמשך, multi-tenant, Docker image,
endpoint של Prometheus, ועוד. PRs יתקבלו בברכה.

## רישיון

[MIT](LICENSE) © 2026 נעם ניסן (Noam Nissan)

## תודות

- [@WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — הלב של הפרויקט.
- Green-API — על שהראו ש-HTTP פשוט עדיף על SDK מסובך.

</div>
