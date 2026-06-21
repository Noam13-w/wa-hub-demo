// ⚠️ LEGAL: wa-hub-demo is an unofficial WhatsApp client (not affiliated with WhatsApp/Meta)
// and may violate WhatsApp's ToS. Send ONLY to recipients who gave prior opt-in consent, and
// comply with GDPR / CAN-SPAM / TCPA / local anti-spam law. No warranty. See ../../DISCLAIMER.md
/**
 * Base44 backend function — send a WhatsApp message via wa-hub-demo.
 *
 * Setup:
 *   1. In Base44 dashboard → Secrets, add:
 *        WA_HUB_URL     = https://your-tunnel-or-domain.com
 *        WA_HUB_TOKEN   = <the HUB_TOKEN from your server's .env>
 *
 *   2. Deploy this function and call it like:
 *        POST https://<your-project>.base44.app/api/functions/send-whatsapp
 *        Authorization: Bearer <your Base44 user token>
 *        Content-Type: application/json
 *        { "to": "+972501234567", "text": "Hello from Base44!" }
 *
 * Expected response: 200 { ok: true, id: "ABCD...", to: "972501234567@s.whatsapp.net" }
 */

const HUB_URL   = Deno.env.get("WA_HUB_URL");
const HUB_TOKEN = Deno.env.get("WA_HUB_TOKEN");

if (!HUB_URL || !HUB_TOKEN) {
  throw new Error("WA_HUB_URL and WA_HUB_TOKEN secrets must be set in Base44");
}

interface SendRequest {
  to: string;
  text: string;
  quotedMessageId?: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: SendRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.to || !body.text) {
    return json({ error: "missing_fields", required: ["to", "text"] }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${HUB_URL}/api/messages/send/text`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${HUB_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
      // Don't hang forever if the Hub/tunnel is down — fail fast with a clear error.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return json({ error: "hub_unreachable", message: String((err as Error)?.message ?? err) }, 502);
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    data = { ok: upstream.ok, status: upstream.status };
  }
  return json(data, upstream.status);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
