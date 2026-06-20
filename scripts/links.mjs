#!/usr/bin/env node
/* ============================================================================
 * QNB Movie Night — confirm-link exporter
 * ----------------------------------------------------------------------------
 * While the WhatsApp Business API is under review (can't auto-send), use this to
 * export a per-guest list of personal "confirm your attendance" links so you can
 * deliver them through ANY channel: a bulk WhatsApp tool, a mail-merge, or by
 * tapping the ready-made wa.me links yourself.
 *
 * Reads confirmed guests with the SERVICE-ROLE key from .env (RLS-bypassing,
 * never in git). Writes links.csv and prints a short preview.
 *
 *   node scripts/links.mjs                       # all confirmed guests
 *   node scripts/links.mjs --base https://qnbmovienight.netlify.app
 *   node scripts/links.mjs --pending            # only those not yet asked
 *   node scripts/links.mjs --out links.csv
 * ==========================================================================*/

import fs from "node:fs";
import process from "node:process";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const BASE = String(flag("base", process.env.PUBLIC_BASE_URL || "https://qnbmovienight.netlify.app")).replace(/\/$/, "");
const OUT = String(flag("out", "links.csv"));
const PENDING_ONLY = !!flag("pending", false);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("\n✖ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).\n");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let q = sb.from("guests").select("name, wa_phone, ticket_token, hall, guest_count, attendance, confirm_sent_at")
  .eq("status", "confirmed").order("name", { ascending: true });
if (PENDING_ONLY) q = q.is("attendance", null);

const { data, error } = await q;
if (error) { console.error("✖ Query failed:", error.message); process.exit(1); }

const csvCell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const rows = [["name", "wa_phone", "confirm_url", "wa_me_link", "hall", "guest_count"]];

for (const g of data ?? []) {
  const url = `${BASE}/confirm.html?t=${g.ticket_token}`;
  const text = `Hi ${(g.name || "there").split(" ")[0]}! It's QNB Movie Night (Toy Story 5) today. Please confirm your seat: ${url}`;
  const waMe = g.wa_phone ? `https://wa.me/${g.wa_phone}?text=${encodeURIComponent(text)}` : "";
  rows.push([g.name, g.wa_phone, url, waMe, g.hall, g.guest_count]);
}

fs.writeFileSync(OUT, rows.map((r) => r.map(csvCell).join(",")).join("\n"));

console.log(`\n  Exported ${rows.length - 1} confirm link(s) -> ${OUT}`);
console.log(`  Base URL: ${BASE}${PENDING_ONLY ? "   (pending only)" : ""}\n`);
console.log("  First 5:");
for (const g of (data ?? []).slice(0, 5)) {
  console.log(`    ${String(g.name || "").padEnd(26)} ${BASE}/confirm.html?t=${g.ticket_token}`);
}
console.log("");
