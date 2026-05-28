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

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Raw body (must read as text, *not* as JSON — signature is over the bytes)
  const body = await req.text();

  const given    = req.headers.get("x-hub-signature") ?? "";
  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET!).update(body).digest("hex");

  // Constant-time comparison
  if (given.length !== expected.length) {
    return new Response("invalid signature length", { status: 401 });
  }
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return new Response("invalid signature", { status: 401 });
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
    const from = event.data.from as string;
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
          to:   from,
          text: `Got it! You said: "${text}"`,
        }),
      });
    }
  }

  return new Response("ok", { status: 200 });
}
