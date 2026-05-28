<div dir="rtl" align="right">

# CHEAT SHEET — להדפיס · להחזיק ביד · להציץ ב-3 שניות

---

## משתנים סביבתיים שצריכים להיות בראש

```
HUB_URL    = https://_________________________.trycloudflare.com
HUB_TOKEN  = _____________________________________________________________ (64 hex)
SECRET     = _____________________________________________________________ (64 hex)
TEST_NUM   = 35796699735   ← רועי לוי · עונה אוטומטית
```

> `TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)` — תיכף יהיה זמין בכל shell.

---

## 5 פקודות הכי נפוצות

**1. שליחת טקסט (הדמו המנצח):**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"35796699735","text":"היי מהוובינר 🎉"}' \
  http://127.0.0.1:3060/api/messages/send/text
```

**2. בדיקת חיים:**
```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/healthz
```

**3. בקשת QR חדש (אחרי logout):**
```bash
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/qr.png -o /tmp/qr.png
```

**4. הורדת QR למקומי + פתיחה (PowerShell):**
```powershell
scp root@<IP>:/tmp/qr.png $HOME\qr.png; Start-Process $HOME\qr.png
```

**5. שליפת URL של Cloudflare Tunnel:**
```bash
journalctl -u cloudflared-wahub -n 50 --no-pager | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

---

## Base44 — 3 secrets שצריך להזכיר

| Secret | מה זה |
|---|---|
| `WA_HUB_URL` | ה-URL של Cloudflare Tunnel (משתנה בכל restart במצב Quick) |
| `WA_HUB_TOKEN` | Bearer auth — מתוך `.env` בשרת |
| `WA_HUB_SECRET` | חתימת HMAC על webhooks — מתוך `.env` בשרת |

> **קריטי:** ב-Base44 webhook — Web Crypto API, **לא** `Buffer` של Node.

---

## אם משהו נתקע — לחץ Ctrl+L לנקות ותמשיך

> אתה בנית את זה. אתה יודע את זה. תדבר. הקוד יסדר את עצמו.

</div>
