<div dir="rtl" align="right">

# WhatsApp Hub עצמאי — תקציר וובינר

**מגיש:** נעם ניסן · **תאריך:** מאי 2026 · **משך:** ~75 דקות

---

## 5 דברים שכדאי לקחת הביתה

1. **WhatsApp Web זה פרוטוקול, לא אפליקציה.** הטלפון שלך הוא המקור. כל "Linked Device" — דפדפן, שרת, או הקוד שלנו — רק מתרגם.

2. **Baileys + Express + Cloudflare Tunnel = API שלם.** שלוש חתיכות פתוחות, מורכבות ב-30 דקות, רצות לעד.

3. **עלות קבועה, בעלות מלאה.** €3.99 לחודש = שרת. בלי תשלום per-message, בלי תקרה.
   הקוד שלך, המפתחות שלך, ההודעות שלך.

4. **כל מערכת שמדברת HTTP יכולה להשתמש בזה.** Bubble, Base44, Make, n8n, Firebase, Python, PHP, Apps Script — POST פשוט אל endpoint.

5. **זו שיטה לא-רשמית — והמספר שלך יכול להיחסם.** התחברות כ-Linked Device לא-רשמי כנראה מפֵרה את תנאי השימוש של WhatsApp, ו-Meta רשאית לחסום את המספר לפי שיקול דעתה. הסיכון נמוך כשמתנהגים כאדם ושולחים רק למי שנתן הסכמה מפורשת; גבוה מאוד ב-cold outreach או בנפח גבוה. השימוש על אחריותכם.

---

## 3 פקודות לזכור

**שליחה:**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"to":"972585802298","text":"שלום"}' \
     $HUB_URL/api/messages/send/text
```

**סטטוס:**
```bash
curl -H "Authorization: Bearer $TOKEN" $HUB_URL/api/instance/status
```

**רישום webhook:**
```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"url":"https://your-app.com/wa","events":["message.incoming"]}' \
     $HUB_URL/api/instance/webhook
```

---

## לינקים

| מה | היכן |
|---|---|
| **קוד מקור (MIT)** | [github.com/Noam13-w/wa-hub-demo](https://github.com/Noam13-w/wa-hub-demo) |
| **מדריך התקנה מלא (HE)** | [docs/BUILD_GUIDE_HE.md](https://github.com/Noam13-w/wa-hub-demo/blob/main/docs/BUILD_GUIDE_HE.md) |
| **תיעוד API** | [docs/API.md](https://github.com/Noam13-w/wa-hub-demo/blob/main/docs/API.md) |
| **ארכיטקטורה** | [docs/ARCHITECTURE.md](https://github.com/Noam13-w/wa-hub-demo/blob/main/docs/ARCHITECTURE.md) |
| **סלייד הוובינר** | [docs/slides/index.html](https://github.com/Noam13-w/wa-hub-demo/blob/main/docs/slides/index.html) |
| **התקנת express (שורה אחת)** | `curl -fsSL https://raw.githubusercontent.com/Noam13-w/wa-hub-demo/main/deploy/install.sh \| bash` |

---

## ההוצאות החודשיות הצפויות

| פריט | עלות |
|---|---|
| Hetzner CX23 (4GB RAM, x86) | €3.99/חודש |
| Hetzner CAX11 (4GB RAM, ARM) | €3.79/חודש |
| Cloudflare Tunnel | חינם |
| דומיין (אופציונלי, ל-Named Tunnel) | ~$10/שנה |
| **סה"כ** | **~€50/שנה** |

---

## שאלה? צריך עזרה?

- **GitHub Issues:** [github.com/Noam13-w/wa-hub-demo/issues](https://github.com/Noam13-w/wa-hub-demo/issues) — הכי מהיר
- **Email:** noamnissan10@gmail.com
- **LinkedIn:** Noam Nissan

> תרגישו חופשי לפתוח PR אם מצאתם משהו לתקן. הפרויקט פתוח לכל אחד.

---

<div align="center">

**תודה שבאתם · עכשיו לכו לבנות**

</div>

</div>
