// ⚠️ LEGAL: wa-hub-demo is an unofficial WhatsApp client (not affiliated with WhatsApp/Meta)
// and may violate WhatsApp's ToS. Only auto-reply to people who consented to be contacted, and
// comply with GDPR / CAN-SPAM / TCPA / local anti-spam law. No warranty. See ../../DISCLAIMER.md
/**
 * Base44 backend function — receive incoming WhatsApp messages from wa-hub-demo.
 *
 * Setup:
 *   1. In Base44 dashboard → Secrets, add:
 *        WA_HUB_WEBHOOK_SECRET = <the WEBHOOK_SECRET from your server's .env>
 *
 *   2. Deploy this function. Copy its public URL — it looks like:
 *        https://<your-project>.base44.app/api/functions/whatsapp-incoming
 *
 *   3. Tell the Hub to deliver events to it:
 *        curl -X PUT \
 *          -H "Authorization: Bearer $HUB_TOKEN" \
 *          -H "Content-Type: application/json" \
 *          -d '{
 *            "url": "https://<your-project>.base44.app/api/functions/whatsapp-incoming",
 *            "events": ["message.incoming"]
 *          }' \
 *          https://your-hub-url.com/api/instance/webhook
 *
 * Security note:
 *   The Hub signs every payload with HMAC-SHA256. We *must* verify before
 *   trusting the data — otherwise anyone who knows the URL can forge events.
 */

// HMAC verification uses the Web Crypto API ONLY. Base44's Deno runtime does not
// reliably expose Node's `Buffer` / `node:crypto` — importing them can crash the
// function with a 500. `crypto.subtle` + `TextEncoder` are always available.

const WEBHOOK_SECRET = Deno.env.get("WA_HUB_WEBHOOK_SECRET");
if (!WEBHOOK_SECRET) {
  throw new Error("WA_HUB_WEBHOOK_SECRET must be set in Base44");
}

interface HubEvent {
  event: string;
  timestamp: number;
  instance: string;
  data: Record<string, unknown>;
}

/** HMAC-SHA256 over the raw body, formatted as the Hub's `sha256=<hex>` header. */
async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "sha256=" + hex;
}

/** Length-checked, constant-time string compare — no Buffer needed. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Replay protection ─────────────────────────────────────────────────
// A valid signed payload can be captured and re-POSTed. We reject deliveries
// whose timestamp is outside a window, and dedup on the per-delivery id the Hub
// sends. (This in-memory set resets on cold start — back it with a KV/Redis
// store with TTL in production.)
const MAX_SKEW_MS = 5 * 60 * 1000;
const seenDeliveries = new Set<string>();

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Raw body (must read as text, *not* as JSON — signature is over the bytes)
  const body = await req.text();

  const given    = req.headers.get("x-hub-signature") ?? "";
  const expected = await sign(body, WEBHOOK_SECRET);

  if (!safeEqual(given, expected)) {
    return new Response("invalid signature", { status: 401 });
  }

  // Reject stale (replayed) deliveries by timestamp …
  const ts = Number(req.headers.get("x-hub-timestamp"));
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    return new Response("stale or missing timestamp", { status: 401 });
  }
  // … and dedup retries / replays by the per-delivery id.
  const delivery = req.headers.get("x-hub-delivery") ?? "";
  if (delivery) {
    if (seenDeliveries.has(delivery)) return new Response("duplicate", { status: 200 });
    seenDeliveries.add(delivery);
  }

  let event: HubEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // ─── Your logic goes here ──────────────────────────────────────────
  // The example below just logs and echoes "got it!" on text messages.
  console.log(`[${event.event}]`, JSON.stringify(event.data, null, 2));

  if (event.event === "message.incoming" && event.data.type === "text") {
    // Reply to `chat` (the conversation), NOT `from` (the sender). In a group
    // these differ — replying to `from` would DM the sender instead of the group.
    const chat = event.data.chat as string;
    const text = event.data.text as string;

    // Optionally — reply automatically by calling the Hub back.
    // (Requires WA_HUB_URL and WA_HUB_TOKEN secrets to also be set.)
    const HUB_URL   = Deno.env.get("WA_HUB_URL");
    const HUB_TOKEN = Deno.env.get("WA_HUB_TOKEN");
    if (HUB_URL && HUB_TOKEN) {
      await fetch(`${HUB_URL}/api/messages/send/text`, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${HUB_TOKEN}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          to:   chat,
          text: `Got it! You said: "${text}"`,
        }),
      });
    }
  }

  return new Response("ok", { status: 200 });
}
