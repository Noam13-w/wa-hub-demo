<div dir="rtl" align="right">

# פתרון תקלות חי — ALT+TAB לפה כשמשהו נשבר

> שמור את הקובץ הזה פתוח בלשונית נסתרת. סימפטום → אבחנה → תיקון. נקודה.

---

### 🔥 Hub לא עולה · `status=31/SYS` · core-dump

**אבחנה:** systemd seccomp חוסם syscall של Node 20+ (`io_uring`).
**תיקון:**
```bash
mkdir -p /etc/systemd/system/wa-hub.service.d
printf '[Service]\nSystemCallFilter=\n' > /etc/systemd/system/wa-hub.service.d/syscall-fix.conf
systemctl daemon-reload && systemctl restart wa-hub.service
sleep 3 && systemctl status wa-hub --no-pager
```

---

### 🔥 Cloudflare Quick Tunnel URL השתנה באמצע הדמו

**אבחנה:** Tunnel נפל ועלה — URL רנדומלי חדש.
**תיקון:**
```bash
journalctl -u cloudflared-wahub -n 50 --no-pager | \
  grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```
העתק את ה-URL החדש. אם רישמת אותו ב-Base44 — תעדכן שם (Settings → Secrets → `WA_HUB_URL`).

---

### 🔥 QR פג תוקף לפני שהספקתי לסרוק

**אבחנה:** 60 שניות, רגוע, לא בהלה. ה-Hub מייצר QR חדש אוטומטית.
**תיקון:**
```bash
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/qr.png -o /tmp/qr.png
```
ואז במקומי:
```powershell
scp root@<IP>:/tmp/qr.png $HOME\qr.png; Start-Process $HOME\qr.png
```

---

### 🔥 Base44 webhook מחזיר 500

**אבחנה:** 95% מהמקרים — שימוש ב-`Buffer` / `timingSafeEqual` של Node במקום Web Crypto.
**תיקון:** ב-Base44 → Functions → `whatsappWebhook` → ערוך, החלף את כל אימות החתימה ב:
```javascript
const enc = new TextEncoder();
const key = await crypto.subtle.importKey(
  "raw", enc.encode(WA_HUB_SECRET),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
);
const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
if (("sha256=" + hex) !== given) return new Response("bad sig", { status: 401 });
```

---

### 🔥 Base44 webhook מחזיר 401

**אבחנה:** Secret לא תואם. רווח בהתחלה/סוף או העתקה חלקית.
**תיקון:** בשרת:
```bash
grep WEBHOOK_SECRET /srv/wa-hub-demo/.env
```
העתק לזיכרון בדיוק. ב-Base44 → Settings → Secrets → `WA_HUB_SECRET` → ערוך → הדבק → שמור. **בלי רווחים.**

---

### 🔥 בטלפון: "Linked Device timeout / device disconnected"

**אבחנה:** WhatsApp ניתק. או הטלפון לא היה online 14 יום, או ה-session נשבר.
**תיקון:** פייר מחדש:
```bash
TOKEN=$(grep HUB_TOKEN /srv/wa-hub-demo/.env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/logout
sleep 3
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3060/api/instance/qr.png -o /tmp/qr.png
```
סרוק מהטלפון מחדש.

---

### 🔥 `npm install` נתקע 60+ שניות

**אבחנה:** זה תקין. Baileys + sharp = ~150MB של חבילות.
**תיקון:** שב על הידיים, **דבר על משהו אחר**. אל תקיש Ctrl+C. הוא יסיים תוך 90 שניות מקסימום.

---

### 🔥 SSH מחזיר `Permission denied (publickey)`

**אבחנה:** מפתח לא נטען מ-agent, או IP לא נכון.
**תיקון:**
```powershell
ssh -v root@<IP>
```
חפש בשורות בלי `-v` את `Authentications that can continue: publickey` — אם המפתח שלך לא ברשימת `Offering public key`, הוא לא נטען. הוסף:
```powershell
ssh -i $HOME\.ssh\id_ed25519 root@<IP>
```

---

### 🔥 הודעה לא נשלחה — `not_connected`

**אבחנה:** ה-Hub חי, אבל Baileys לא מחובר ל-WhatsApp.
**תיקון:**
```bash
curl http://127.0.0.1:3060/healthz
```
אם `connection != "open"` — פייר מחדש (ראו "Linked Device timeout" מעלה).

---

### 🔥 Hub מחזיר 429 (Too Many Requests)

**אבחנה:** עברת את ה-`RATE_LIMIT_PER_MIN=120` ב-`.env`.
**תיקון:** עצור 60 שניות, ואז המשך. או הגדל זמנית:
```bash
sed -i 's/^RATE_LIMIT_PER_MIN=.*/RATE_LIMIT_PER_MIN=600/' /srv/wa-hub-demo/.env
systemctl restart wa-hub
```

---

### 🔥 הסקריפט `install.sh` נופל באמצע

**אבחנה:** רוב הפעמים — חיבור אינטרנט קצר או GitHub rate limit.
**תיקון:** הסקריפט idempotent. פשוט הרץ אותו שוב:
```bash
curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh | bash
```

---

> **כלל הזהב:** אם לא ידעת תוך 30 שניות איך לתקן — דלג. אמור "אדגים את זה אחרי הוובינר".
> המשך הלאה. **הקהל לא ירצה לראות אותך מתאמן בדיבאג, גם אם זה מרשים אותך.**

</div>
