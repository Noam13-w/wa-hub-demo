<!-- English version above ⬆  ·  גרסה אנגלית: docs/INTEGRATION.md -->

# wa-hub-demo — מדריך אינטגרציה

**אפשר להעביר את המסמך הזה כמו שהוא למתכנת, ל-Base44, או לסוכן AI שכותב קוד (Claude Code / Cursor).
יש בו כל מה שצריך כדי לעבוד נכון עם ה-API של וואטסאפ הזה.**

`wa-hub-demo` הוא **WhatsApp HTTP API בהוסטינג עצמי**. הוא רץ על שרת שלך ומגשר לוואטסאפ דרך **מכשיר מקושר**
(בדיוק כמו WhatsApp Web). שולטים בו עם **REST + JSON** רגיל, ומקבלים הודעות/אירועים נכנסים דרך **webhooks**
(או WebSocket). זה **לא** ה-WhatsApp Business API הרשמי — זה קליינט לא-רשמי (Baileys). ראו הערה משפטית בסוף.

---

## ⚡ בקצרה (קראו את זה קודם)

```
BASE_URL   = כתובת המנהרה שלך (https://<random>.trycloudflare.com) או ה-subdomain שלך (https://wa.yourdomain.com)
AUTH       = header  Authorization: Bearer <HUB_TOKEN>     בכל קריאה ל-/api/*
תנאי מקדים = חייבים לקשר (pair) מכשיר וואטסאפ פעם אחת (לסרוק QR) לפני ששליחה עובדת
שליחת טקסט = POST <BASE_URL>/api/messages/send/text   {"to":"972501234567","text":"hi"}
קבלה       = מגדירים webhook (PUT /api/instance/webhook); ה-Hub שולח אירועים לכתובת שלכם,
             חתומים ב-HMAC-SHA256 עם <WEBHOOK_SECRET> (header x-hub-signature) — צריך לאמת.
עדיין לא מחובר → שליחה מחזירה 503 {"error":"not_connected"}.  טוקן שגוי → 401.  יותר מדי → 429.
```

יש **שני מושגים** שחייבים להבין לפני שכותבים קוד: **(1) שיוך (pairing)** ו**(2) שתי הסיסמאות**. שניהם מוסברים מיד.

---

## 1. מושג #1 — שיוך (קישור מכשיר וואטסאפ), פעם אחת

ה-Hub לא יכול לשלוח או לקבל כלום עד ש**חשבון וואטסאפ אמיתי מקושר אליו**, בדיוק כמו שמקשרים WhatsApp Web/Desktop.
זה **צעד אנושי חד-פעמי** (מישהו סורק QR עם הטלפון).

**איך מבצעים שיוך:**
1. פותחים **`<BASE_URL>/pair`** בדפדפן.
2. מדביקים את ה-`HUB_TOKEN` כשמתבקשים (או פותחים `<BASE_URL>/pair#<HUB_TOKEN>` — החלק שאחרי ה-`#` נשאר
   בדפדפן ולעולם לא נשלח לשרת).
3. בטלפון: **וואטסאפ → הגדרות → מכשירים מקושרים → קישור מכשיר**, סורקים את ה-QR.
4. העמוד הופך ל**קונסולה** (כפתור "שלח בדיקה", דוגמאות API מוכנות, הגדרת webhook).

**תכונות חשובות:**
- ה-session נשמר על השרת (`data/auth/`). הוא שורד אתחולים — מקשרים **פעם אחת**.
- אם **הטלפון הראשי כבוי/מנותק ~14 יום**, וואטסאפ מנתק את כל המכשירים וצריך לקשר מחדש.
- כדי לכפות שיוך מחדש: `POST /api/instance/logout`, ואז לטעון מחדש את `/pair`.
- **בדקו את המצב בקוד לפני שליחה:**
  ```
  GET <BASE_URL>/api/instance/status   →   { "connection": "connected", "me": {...}, ... }
  ```
  `connection` הוא אחד מ-`disconnected` | `connecting` | `qr` | `connected`. **שולחים רק כשהוא
  `connected`.** אחרת כל endpoint של שליחה מחזיר `503 {"error":"not_connected"}`.

---

## 2. מושג #2 — שתי הסיסמאות ("2 סיסמאות")

יש **שתי סיסמאות נפרדות**, שמכוונות ל**כיוונים הפוכים**:

| סיסמה | כיוון | מה היא מגנה | איך משתמשים |
|---|---|---|---|
| **`HUB_TOKEN`** | **אתם → Hub** | הקריאות שלכם *אל* ה-API | Header `Authorization: Bearer <HUB_TOKEN>` ב**כל** בקשת `/api/*` (וגם ב-WebSocket). |
| **`WEBHOOK_SECRET`** | **Hub → אתם** | אירועים שה-Hub שולח *אליכם* | ה-Hub חותם כל גוף-webhook ב-HMAC-SHA256 עם המפתח הזה; אתם מאמתים את ה-header `x-hub-signature` כדי לוודא שהקריאה באמת מה-Hub שלכם. |

> חשבו על `HUB_TOKEN` כ**סיסמה לשלוט בוואטסאפ**, ועל `WEBHOOK_SECRET` כ**סיסמה שמוכיחה שה-webhook הנכנס
> באמת הגיע מה-Hub שלכם** (ולא זיוף שמכוון לכתובת שלכם).

**סיסמה שלישית אופציונלית — `ADMIN_TOKEN`:** אם היא מוגדרת, ה-routes ה*הרסניים/הגדרה*
(`POST /api/instance/logout` ו-`PUT /api/instance/webhook`) דורשים בנוסף header `X-Admin-Token: <ADMIN_TOKEN>`.
כך אפשר לחלק את ה-`HUB_TOKEN` לשליחה/קריאה תוך שמירת ה-logout/שינוי-webhook מאחורי מפתח נפרד. אם
`ADMIN_TOKEN` לא מוגדר — מספיק `HUB_TOKEN`.

**איפה הסיסמאות:** נוצרות בהתקנה, נשמרות ב-`/srv/wa-hub-demo/.env` (הרשאות `600`, בעלים `wahub`). לחשיפה
על השרת:
```bash
sudo grep -E '^(HUB_TOKEN|WEBHOOK_SECRET)=' /srv/wa-hub-demo/.env
```
שמרו אותן במנהל סיסמאות. **לסיבוב (rotate):** ערכו את `.env` → `sudo systemctl restart wa-hub` → עדכנו את הצרכנים.

---

## 3. כתובת הבסיס (Base URL)

כתובת הבסיס של ה-API היא מה שחושף את ה-Hub לאינטרנט:

- **Quick Tunnel** (ברירת המחדל שההתקנה מקימה): `https://<random>.trycloudflare.com`.
  ⚠️ **הכתובת הזו ארעית — היא מתחלפת בכל אתחול של המנהרה (reboot/קריסה/עדכון).** מצוין לבדיקות; **אל**
  תקבעו אותה בקוד לפרודקשן.
- **Named Tunnel על subdomain שלכם** (מומלץ לשימוש אמיתי): `https://wa.yourdomain.com` — **יציב**, שורד
  אתחולים. מדריך הקמה: **[SUBDOMAIN.md](SUBDOMAIN.md)**.
- **על השרת עצמו:** `http://127.0.0.1:3060`.

כל הנתיבים למטה הם **יחסית לכתובת הבסיס**.

---

## 4. אימות (בכל בקשה)

```
Authorization: Bearer <HUB_TOKEN>
```

- טוקן חסר/שגוי → **`401 {"error":"unauthorized"}`**.
- עדיין לא מקושר → **`503 {"error":"not_connected"}`** (ב-routes של שליחה).
- הגבלת קצב: **120 בקשות/דקה לכל IP** כברירת מחדל → **`429 {"error":"rate_limited"}`**.
- צורת ה-`?token=` ב-query **כבויה כברירת מחדל** (דולפת ללוגים); תמיד עדיף ה-header.
- Routes **פתוחים** שלא צריכים טוקן: `GET /healthz` ו-`GET /pair`.

---

## 5. התחלה מהירה (copy-paste)

```bash
BASE="https://wa.yourdomain.com"        # או כתובת ה-trycloudflare שלכם
TOKEN="<HUB_TOKEN>"

# 1) מקושר ומוכן?
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/instance/status"

# 2) שליחת הודעת טקסט
curl -s -X POST "$BASE/api/messages/send/text" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"972501234567","text":"hello from wa-hub"}'

# 3) האם מספר קיים בוואטסאפ?
curl -s -X POST "$BASE/api/check/number" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"numbers":["972501234567"]}'

# 4) קבלת הודעות נכנסות — הפנו את ה-Hub ל-webhook שלכם
curl -s -X PUT "$BASE/api/instance/webhook" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://your-server.com/wa-hook","events":["message.incoming"]}'
```

---

## 6. רפרנס endpoints (אלה שתשתמשו בהם הכי הרבה)

> נמען (`to`) מקבל: `+972501234567`, `972501234567` (ספרות בלבד, מנורמל ל-`…@s.whatsapp.net`),
> `972501234567@s.whatsapp.net`, קבוצה `…@g.us`, או `…@lid`. השתמשו בקידומת המדינה **בלי** `0` מוביל
> (ישראלי `058…` → `97258…`).

### שליחת הודעות — `POST /api/messages/...`  *(דורש `connected`)*
| Route | Body | הערות |
|---|---|---|
| `/send/text` | `{ "to", "text", "quotedMessageId?" }` | `text` 1–4096 תווים |
| `/send/image` | `{ "to", "imageUrl"｜"imageBase64", "caption?" }` | מדיה ≤20 MB |
| `/send/file` | `{ "to", "fileUrl"｜"fileBase64", "filename", "mimetype?", "caption?" }` | כל מסמך |
| `/send/audio` | `{ "to", "audioUrl"｜"audioBase64", "ptt?" }` | `ptt:true` = הודעה קולית |
| `/send/location` | `{ "to", "latitude", "longitude", "name?", "address?" }` | |
| `/send/reaction` | `{ "to", "messageId", "emoji", "fromMe?" }` | `emoji` ריק מסיר |
| `/markRead` | `{ "to", "messageId", "fromMe?" }` | סימון כנקרא |

מדיה: **URL ציבורי** (`...Url`) *או* **base64** (`...Base64`, יכול להיות `data:` URL). מקסימום **20 MB**
מפוענח → אחרת `413 file_too_large`. routes של שליחה מחזירים `{ "ok": true, "id": "<msgId>", "to": "<jid>" }`.

### בדיקה — `POST /api/check/number`
`{ "numbers": ["972501234567", ...] }` (1–50) → `{ "results": [ { "input", "exists", "jid" } ] }`. שימושי
לאמת שנמען קיים בוואטסאפ לפני שליחה.

### קבוצות — `/api/groups`
- `GET /api/groups` → `{ "count", "groups": [ { jid, name, participants, owner, creation, announce } ] }`
- `GET /api/groups/:jid` → מטא-דאטה מלא של הקבוצה (`:jid` = ה-id בן 15+ ספרות או `…@g.us`)
- `POST /api/groups/:jid/participants` → `{ "add?", "remove?", "promote?", "demote?" }` (כל רשימה ≤50)

### Instance — `/api/instance`
- `GET /status` → מצב חיבור + החשבון המקושר + הגדרת webhook (תשאלו את זה; שלחו רק כש-`connected`)
- `GET /qr` → `{ "dataUrl", "expiresAt" }` · `409 already_paired` · `404 no_qr` (נסו שוב עוד רגע)
- `GET /qr.png` → ה-QR כ-PNG (לפתיחה בדפדפן; משכו עם `curl -fsS`)
- `GET /diagnose` → JSON של בדיקה עצמית (socket / אינטרנט / env / webhook)
- `POST /smoketest` → שולח הודעת אישור למספר המקושר (כפתור "שלח בדיקה" בקונסולה)
- `GET /webhook` · `PUT /webhook` → קריאה/הגדרה של ה-webhook (ראו §7)
- `GET /webhook/failures` · `GET /errors` → כשלי שליחה / שגיאות routes אחרונות
- `POST /logout` → ניתוק המכשיר והתחלת QR חדש

*(רפרנס מלא endpoint-אחר-endpoint עם כל שדה: [API.md](API.md).)*

---

## 7. קבלת הודעות — Webhooks

מגדירים את המקלט פעם אחת; ה-Hub אז **שולח JSON ב-POST בכל אירוע (מנוי)**:
```bash
curl -X PUT "$BASE/api/instance/webhook" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://your-server.com/wa-hook","events":["message.incoming"]}'
```
- `events: []` (או השמטה) שולח את **כל** האירועים. ההגדרה **נשמרת** (שורדת אתחולים) ודורסת את ברירות
  המחדל מ-`.env`. `url: null` מכבה.

**אירועים:** `message.incoming`, `message.outgoing`, `message.status`, `instance.connected`,
`instance.disconnected`, `instance.qr` (תמונת ה-QR עצמה לעולם לא נשלחת).

**הבקשה שה-Hub שולח אליכם:**
| Header | ערך |
|---|---|
| `content-type` | `application/json` |
| `x-hub-signature` | `sha256=<HMAC-SHA256(WEBHOOK_SECRET, rawBody)>` |
| `x-hub-event` | שם האירוע |
| `x-hub-timestamp` | epoch-ms (דחו אם ישן, למשל >5 דק' — הגנת replay) |
| `x-hub-delivery` | מזהה ייחודי לכל delivery, יציב לאורך retries (dedup לפיו) |

**גוף (Body):**
```json
{ "event": "message.incoming", "timestamp": 1730000000000, "instance": "wa-hub", "data": { ... } }
```

**`data` עבור `message.incoming` / `message.outgoing`:**
```json
{
  "id": "3EB0...", "timestamp": 1730000000000,
  "chat": "972...@s.whatsapp.net", "chatAlt": null, "isGroup": false,
  "from": "972...@s.whatsapp.net", "fromMe": false,
  "fromNumber": "972501234567", "fromLid": false, "fromName": "Dana",
  "type": "text", "text": "hi", "media": null, "quoted": null
}
```
`type` ∈ `text|image|video|audio|document|sticker|location|contact|reaction|poll|unknown`. עבור סוגי מדיה,
`text` הוא הכיתוב ו-`media` מחזיק `{ kind, mimetype, fileLength, ... }` (ה-Hub **לא** מוריד את המדיה; משכו
אותה בעצמכם אם צריך). ב-rollout של **LID** בוואטסאפ ייתכן ש-`fromNumber` הוא בעצמו logical id — `fromLid:true`
מסמן זאת; המזהה היציב הוא `chat`.

**`data` עבור `message.status`:** `{ "id", "chat", "fromMe", "status", "statusCode" }` כאשר `status` ∈
`error|pending|sent|delivered|read|played`.

### ⚠️ אמתו את החתימה (חובה — זו כל המטרה של `WEBHOOK_SECRET`)

חשבו HMAC על **גוף הבקשה הגולמי** (לפני פענוח JSON) והשוו ל-`x-hub-signature`:

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

// קלטו את הגוף הגולמי כדי שהחתימה תתאים בית-אל-בית.
app.post('/wa-hook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body, req.get('x-hub-signature'), process.env.WEBHOOK_SECRET)) {
    return res.status(401).end();            // דחיית זיופים
  }
  const payload = JSON.parse(req.body.toString('utf8'));
  // ... טפלו ב-payload.event / payload.data ...
  res.sendStatus(200);                        // אשרו מהר (2xx)
});
```

**Python (Flask):**
```python
import hmac, hashlib, os
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
    # ... טפלו ב-payload["event"] / payload["data"] ...
    return "", 200
```

**החזירו `2xx` מהר.** Retries: עד 4 ניסיונות (מיידי, +2 שנ', +6 שנ', +18 שנ') **רק** על `5xx`, `408`,
`429`, או שגיאת רשת — כל `4xx` אחר עוצר ונרשם ל-`webhook-failures.json`.

---

## 8. WebSocket (אופציונלי, זמן-אמת)

זרם אירועים לקריאה-בלבד על פורט **`3061`** (loopback כברירת מחדל — צריך לתעל אותו או להגדיר
`WS_HOST=0.0.0.0` כדי להגיע מרחוק). אימות עם אותו טוקן:
```
ws://<host>:3061/        header  Authorization: Bearer <HUB_TOKEN>
```
פריים ראשון: `{ "event": "hello", "data": { "connection", "me" } }`, ואז פריים אחד לכל אירוע
`{ "event", "timestamp", "data" }`. טוקן שגוי סוגר עם קוד `4001`. הזרם נושא תוכן הודעה מלא, אז התייחסו
לטוקן כרגיש. (לרוב האינטגרציות, **webhooks פשוטים יותר ומומלצים**.)

---

## 9. שגיאות ומגבלות

| Status | משמעות |
|---|---|
| `200` | תקין |
| `400` | `invalid_body` / `invalid_json` — צורת בקשה שגויה (בדקו `issues`) |
| `401` | `unauthorized` — `HUB_TOKEN` חסר/שגוי |
| `403` | `forbidden` — צריך `X-Admin-Token` (כש-`ADMIN_TOKEN` מוגדר) |
| `404` | `not_found` / `no_qr` |
| `409` | `already_paired` (ב-`/qr`) |
| `413` | `file_too_large` / `payload_too_large` (מדיה >20 MB) |
| `429` | `rate_limited` (ברירת מחדל 120/דקה/IP) |
| `503` | `not_connected` (לא מקושר) או `unavailable` (עומס) |

כל השגיאות JSON: `{ "error": "<code>", "message": "<טקסט אנושי>" }`.

---

## 10. צ'קליסט אבטחה

- שמרו על `HUB_TOKEN` + `WEBHOOK_SECRET` בסוד (הן סיסמאות). לעולם אל תכניסו ל-git; אל תרשמו בלוגים.
- הקישור המלא `/pair#<token>` מכיל את הטוקן שלכם — התייחסו גם אליו כסוד.
- תמיד **אמתו את חתימת ה-webhook** על הגוף הגולמי, ודחו `x-hub-timestamp` ישן.
- העדיפו **subdomain יציב** ([SUBDOMAIN.md](SUBDOMAIN.md)) לכל דבר מתמשך.
- ה-Hub חוסם בקשות יוצאות ל-IP פרטי/loopback/metadata (אנטי-SSRF) אלא אם תגדירו `ALLOW_PRIVATE_EGRESS=true`.

---

## 11. תקציר מוכן-להדבקה לסוכן AI (Base44 / Claude Code)

> אתה משלב את **wa-hub-demo**, WhatsApp HTTP API בהוסטינג עצמי.
> - Base URL: `<BASE_URL>`. אימות: header `Authorization: Bearer <HUB_TOKEN>` בכל קריאת `/api/*`.
> - תנאי מקדים: מכשיר וואטסאפ כבר חייב להיות מקושר; `GET /api/instance/status` חייב להחזיר
>   `connection:"connected"` לפני שליחה, אחרת שליחה מחזירה `503 not_connected`.
> - שליחת טקסט: `POST /api/messages/send/text` עם `{"to":"<E164-בלי-פלוס>","text":"..."}` →
>   `{ok:true,id,to}`. שליחות אחרות: `/send/image|file|audio|location|reaction`, `/markRead`.
> - בדיקת מספר: `POST /api/check/number {"numbers":[...]}`.
> - קבלת הודעות: הגדר `PUT /api/instance/webhook {"url":"<your-url>","events":["message.incoming"]}`.
>   ה-Hub שולח `{event,timestamp,instance,data}`; אמת header `x-hub-signature: sha256=HMAC_SHA256(<WEBHOOK_SECRET>, rawBody)`
>   על הגוף הגולמי לפני שאתה סומך עליו; החזר 2xx מהר.
> - שגיאות הן JSON `{error,message}`; 401=טוקן שגוי, 429=הגבלת קצב (120/דקה/IP), 503=לא מקושר.
> - מלא `<BASE_URL>`, `<HUB_TOKEN>`, `<WEBHOOK_SECRET>` מהמפעיל (ב-`/srv/wa-hub-demo/.env`).

---

## משפטי / תנאי שימוש

זהו קליינט וואטסאפ **לא-רשמי** (Baileys), לא קשור ל-WhatsApp/Meta, ועלול להפר את תנאי השימוש שלהם. האחריות
עליכם בלבד — לשלוח רק לנמענים מסכימים ולעמוד ב-GDPR / חוק הספאם / דין מקומי. אין אחריות. ראו
[../DISCLAIMER.md](../DISCLAIMER.md).

---

*גרסה אנגלית: [INTEGRATION.md](INTEGRATION.md) · רפרנס API מלא: [API.md](API.md) ·
subdomain יציב: [SUBDOMAIN.md](SUBDOMAIN.md) · הערות פריסה: [DEPLOY.md](DEPLOY.md).*
