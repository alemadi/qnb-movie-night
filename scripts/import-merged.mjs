#!/usr/bin/env node
/* ============================================================================
 * QNB Movie Night — import the merged masterlist into Supabase
 * ----------------------------------------------------------------------------
 * Joins the RSVP form export (Personal Mobile by Work Email) onto the Masterlist
 * workbook (Final Confirmed + Waitlist tabs) and upserts the result into the
 * guests table with the SERVICE-ROLE key from .env (RLS-bypassing).
 *
 *   status   confirmed | waitlist   (from which masterlist tab the guest is on)
 *   name     First Name             guest_count  Party size
 *   mobile   last 8 digits          wa_phone     974 + last 8
 *   hall     left NULL              -> assigned at the door scanner (gate mode)
 *
 * Idempotent: upsert on conflict(mobile) updates name/guest_count/status/wa_phone
 * and PRESERVES ticket_token / checked_in / checked_in_at / attendance. De-dupes
 * by mobile (confirmed wins). Dry-run by default; --commit to write.
 *
 *   node scripts/import-merged.mjs --rsvp rsvp.xlsx --master masterlist.xlsx
 *   node scripts/import-merged.mjs --rsvp r.xlsx --master m.xlsx --commit
 * ==========================================================================*/

import fs from "node:fs";
import process from "node:process";
import "dotenv/config";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const COMMIT = process.argv.includes("--commit");
const RSVP = arg("rsvp"), MASTER = arg("master");
if (!RSVP || !MASTER) { console.error("\n✖ Usage: --rsvp <file.xlsx> --master <file.xlsx> [--commit]\n"); process.exit(1); }

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const email = (s) => String(s ?? "").trim().toLowerCase();
function mobileOf(r) {
  const m = digits(r["Personal Mobile Number"]); if (m.length >= 8) return m.slice(-8);
  const e = digits(r["Office Extension Number"]); if (e.length === 8 && /^[3567]/.test(e)) return e;
  return "";
}

const rwb = XLSX.read(fs.readFileSync(RSVP), { type: "buffer" });
const rrows = XLSX.utils.sheet_to_json(rwb.Sheets[rwb.SheetNames[0]], { defval: "", raw: false });
const mobByEmail = new Map();
for (const r of rrows) { const e = email(r["Work Email"]); if (e && !mobByEmail.has(e)) { const m = mobileOf(r); if (m) mobByEmail.set(e, m); } }

const mwb = XLSX.read(fs.readFileSync(MASTER), { type: "buffer" });
function tab(name, status) {
  const aoa = XLSX.utils.sheet_to_json(mwb.Sheets[name], { header: 1, defval: "", raw: false });
  const hi = aoa.findIndex((r) => String(r[0]).trim().toLowerCase() === "first name");
  const out = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const [fn, em, ps] = aoa[i]; if (!em && !fn) continue;
    const mob = mobByEmail.get(email(em)) || "";
    if (!mob) continue;
    out.push({ mobile: mob, name: String(fn).trim() || "Guest", guest_count: parseInt(digits(ps), 10) || 1, status, wa_phone: "974" + mob });
  }
  return out;
}
const confirmed = tab(mwb.SheetNames.find((s) => /confirmed/i.test(s)), "confirmed");
const waitlist = tab(mwb.SheetNames.find((s) => /waitlist|not selected/i.test(s)), "waitlist");

const seen = new Set(); const rows = [];
for (const g of [...confirmed, ...waitlist]) { if (seen.has(g.mobile)) continue; seen.add(g.mobile); rows.push(g); }
const heads = (s) => rows.filter((g) => g.status === s).reduce((a, g) => a + g.guest_count, 0);

console.log("\n══════════════ import-merged ══════════════");
console.log(`  ${COMMIT ? "COMMIT" : "DRY-RUN"}  ·  unique guests: ${rows.length}`);
console.log(`  confirmed: ${rows.filter((g) => g.status === "confirmed").length} / ${heads("confirmed")} heads`);
console.log(`  waitlist : ${rows.filter((g) => g.status === "waitlist").length} / ${heads("waitlist")} heads`);
console.log("  first 5:", rows.slice(0, 5).map((g) => `${g.name}(${g.mobile},${g.guest_count},${g.status})`).join("  "));

if (!COMMIT) { console.log("\n  Dry-run — nothing written. Re-run with --commit.\n"); process.exit(0); }

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("\n✖ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env\n"); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

let written = 0;
for (let i = 0; i < rows.length; i += 200) {
  const slice = rows.slice(i, i + 200);
  const { error, count } = await sb.from("guests").upsert(slice, { onConflict: "mobile", count: "exact" });
  if (error) { console.error("✖ Upsert failed:", error.message); process.exit(1); }
  written += count ?? slice.length;
}
console.log(`\n  ✓ Imported/updated ${written} guests.\n`);
