// QNB Movie Night — WhatsApp day-of broadcast sender (Meta Cloud API)
// ----------------------------------------------------------------------------
// Sends the "confirm your attendance" template (with Yes/No quick-reply buttons)
// to confirmed guests who haven't been asked yet. Each button payload carries
// that guest's ticket_token so the webhook can round-trip the right person.
//
// Deploy with verify_jwt = FALSE; protected by the X-Send-Secret header.
// POST with header  X-Send-Secret: <WA_SEND_SECRET>
//   body {}                                         -> broadcast to all pending confirmed guests
//   body { "limit": 20 }                            -> broadcast at most N (safe batch)
//   body { "test_to": "9745xxxxxxx", "test_name": "Ali", "test_token": "<uuid>" } -> one test send
//
// Required secrets: WA_SEND_SECRET, WA_TOKEN, WA_PHONE_ID, WA_TEMPLATE,
// WA_TEMPLATE_LANG (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY auto-injected).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const GRAPH = "https://graph.facebook.com/v21.0";

function confirmTemplate(to: string, name: string, token: string) {
  return {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: env("WA_TEMPLATE", "movie_confirm"),
      language: { code: env("WA_TEMPLATE_LANG", "en") },
      components: [
        { type: "body", parameters: [{ type: "text", text: name }] },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `yes:${token}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `no:${token}` }] },
      ],
    },
  };
}

async function waSend(payload: unknown): Promise<{ ok: boolean; status: number; body: string }> {
  const token = env("WA_TOKEN"), phoneId = env("WA_PHONE_ID");
  if (!token || !phoneId) return { ok: false, status: 0, body: "WA creds unset" };
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ok: r.ok, status: r.status, body: await r.text() };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = env("WA_SEND_SECRET");
  if (!secret || req.headers.get("x-send-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const body = await req.json().catch(() => ({}));
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

  // Single test send
  if (body.test_to) {
    const res = await waSend(confirmTemplate(String(body.test_to), String(body.test_name ?? "there"), String(body.test_token ?? "00000000-0000-0000-0000-000000000000")));
    return json({ mode: "test", to: body.test_to, ...res });
  }

  // Broadcast to confirmed guests not yet asked
  const limit = Number.isFinite(+body.limit) ? Math.max(1, +body.limit) : 1000;
  const { data: guests, error } = await sb
    .from("guests")
    .select("name, wa_phone, ticket_token")
    .eq("status", "confirmed")
    .is("attendance", null)
    .is("confirm_sent_at", null)
    .limit(limit);
  if (error) return json({ error: error.message }, 500);

  let sent = 0, failed = 0;
  const failures: unknown[] = [];
  for (const g of guests ?? []) {
    if (!g.wa_phone) { failed++; continue; }
    const res = await waSend(confirmTemplate(g.wa_phone, (g.name || "there").split(" ")[0], g.ticket_token));
    if (res.ok) {
      sent++;
      await sb.from("guests").update({ confirm_sent_at: new Date().toISOString() }).eq("ticket_token", g.ticket_token);
    } else {
      failed++; failures.push({ to: g.wa_phone, status: res.status, body: res.body });
    }
  }
  return json({ mode: "broadcast", candidates: guests?.length ?? 0, sent, failed, failures: failures.slice(0, 5) });
});
