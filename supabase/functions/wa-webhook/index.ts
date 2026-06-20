// QNB Movie Night — WhatsApp webhook (Meta Cloud API)
// ----------------------------------------------------------------------------
// Receives quick-reply button taps from the day-of "confirm attendance" template
// and drives the same confirm_attendance() RPC the web page uses.
//   yes:<token>  -> reply with a link to the seat-picker page (the guest sets
//                   how many seats they need there and gets their QR).
//   no:<token>   -> decline + auto-promote a waitlister, then send THAT person
//                   the same confirm template.
//
// Deploy with verify_jwt = FALSE (Meta calls it unauthenticated); security is
// the X-Hub-Signature-256 HMAC check below. Dormant & safe until the secrets
// are set: with no WA_APP_SECRET every POST is rejected, with no WA creds no
// outbound message is sent.
//
// Required Edge Function secrets (Dashboard → Edge Functions → Manage secrets):
//   WA_VERIFY_TOKEN   any string you also enter in the Meta webhook config
//   WA_APP_SECRET     Meta App → Settings → Basic → App secret
//   WA_TOKEN          WhatsApp permanent access token
//   WA_PHONE_ID       WhatsApp phone number ID
//   WA_TEMPLATE       template name (default: movie_confirm)
//   WA_TEMPLATE_LANG  template language code (default: en)
//   PUBLIC_BASE_URL   e.g. https://qnbmovienight.netlify.app
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const GRAPH = "https://graph.facebook.com/v21.0";

async function validSignature(raw: Uint8Array, header: string | null): Promise<boolean> {
  const secret = env("WA_APP_SECRET");
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = header.slice(7);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, raw);
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function waSend(payload: unknown): Promise<void> {
  const token = env("WA_TOKEN"), phoneId = env("WA_PHONE_ID");
  if (!token || !phoneId) { console.log("WA creds unset — would send:", JSON.stringify(payload)); return; }
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("WA send failed", r.status, await r.text());
}

function textMsg(to: string, body: string) {
  return { messaging_product: "whatsapp", to, type: "text", text: { preview_url: true, body } };
}

// The confirm template: body var {{1}} = name, two quick-reply buttons whose
// payloads carry this guest's token so the tap round-trips the right person.
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

async function handleAnswer(fromWaId: string, payload: string) {
  const m = /^(yes|no):(.+)$/i.exec(payload.trim());
  if (!m) return;
  const answer = m[1].toLowerCase(), token = m[2];
  const base = env("PUBLIC_BASE_URL");

  // YES -> send a link to pick seat count + get the QR (finalised on the page,
  // so the guest can release seats if part of their group cancelled).
  if (answer === "yes") {
    await waSend(textMsg(fromWaId,
      `🎬 Great! Confirm how many seats you need and get your QR ticket here:\n${base}/confirm.html?t=${token}`));
    return;
  }

  // NO -> decline immediately (frees the seat), then promote a waitlister.
  const { data, error } = await sb.rpc("confirm_attendance", { p_token: token, p_answer: "no" });
  if (error) { console.error("confirm_attendance error", error); return; }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) { await waSend(textMsg(fromWaId, "Sorry, that confirmation link is no longer valid. Please see a staff member.")); return; }

  await waSend(textMsg(fromWaId, "Thanks for letting us know — your seat has been released. Hope to see you next time! 💛"));
  if (row.promoted_found && row.promoted_wa_phone) {
    await waSend(confirmTemplate(row.promoted_wa_phone, (row.promoted_name || "there").split(" ")[0], row.promoted_token));
    await sb.from("guests").update({ confirm_sent_at: new Date().toISOString() })
      .eq("ticket_token", row.promoted_token);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1) Webhook verification handshake (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (mode === "subscribe" && token && token === env("WA_VERIFY_TOKEN")) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // 2) Verify Meta signature over the RAW body
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await validSignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }

  // 3) Parse + dispatch button taps. Always 200 so Meta doesn't retry-storm.
  try {
    const body = JSON.parse(new TextDecoder().decode(raw));
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          const from = msg.from;
          if (msg.type === "button" && msg.button?.payload) {
            await handleAnswer(from, msg.button.payload);
          } else if (msg.type === "interactive" && msg.interactive?.button_reply?.id) {
            await handleAnswer(from, msg.interactive.button_reply.id);
          }
        }
      }
    }
  } catch (e) {
    console.error("webhook parse error", e);
  }
  return new Response("ok", { status: 200 });
});
