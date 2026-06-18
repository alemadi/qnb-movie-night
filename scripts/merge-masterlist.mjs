#!/usr/bin/env node
/* ============================================================================
 * QNB Movie Night — masterlist merge
 * ----------------------------------------------------------------------------
 * Joins the RSVP form export (which holds Personal Mobile Numbers, keyed by
 * Work Email) onto the curated Masterlist workbook (which has the Final
 * Confirmed and Waitlist tabs: First Name / Email / Party size), so each guest
 * ends up with { status, first_name, email, party_size, mobile } ready for the
 * importer and the WhatsApp links.
 *
 * Mobile is normalised to the last 8 digits (matches the DB normalize_mobile);
 * if the Personal Mobile cell is blank it falls back to the Office Extension
 * column when that looks like a real 8-digit Qatari mobile (3/5/6/7 prefix).
 *
 * Writes merged.csv (gitignored — contains personal data) and prints a dry-run.
 *
 *   node scripts/merge-masterlist.mjs --rsvp rsvp.xlsx --master masterlist.xlsx
 *   node scripts/merge-masterlist.mjs --rsvp r.xlsx --master m.xlsx --out merged.csv
 * ==========================================================================*/

import fs from "node:fs";
import process from "node:process";
import * as XLSX from "xlsx";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : d; };
const RSVP = arg("rsvp"), MASTER = arg("master"), OUT = arg("out", "merged.csv");
if (!RSVP || !MASTER) { console.error("\n✖ Usage: --rsvp <file.xlsx> --master <file.xlsx> [--out merged.csv]\n"); process.exit(1); }

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const email = (s) => String(s ?? "").trim().toLowerCase();
function mobileOf(row) {
  const m = digits(row["Personal Mobile Number"]);
  if (m.length >= 8) return m.slice(-8);
  const ext = digits(row["Office Extension Number"]);
  if (ext.length === 8 && /^[3567]/.test(ext)) return ext;
  return "";
}

// 1) RSVP -> email -> mobile
const rwb = XLSX.read(fs.readFileSync(RSVP), { type: "buffer" });
const rrows = XLSX.utils.sheet_to_json(rwb.Sheets[rwb.SheetNames[0]], { defval: "", raw: false });
const mobByEmail = new Map();
for (const r of rrows) {
  const e = email(r["Work Email"]); if (!e) continue;
  const m = mobileOf(r);
  if (m && !mobByEmail.has(e)) mobByEmail.set(e, m);
}

// 2) Masterlist tabs -> records
const mwb = XLSX.read(fs.readFileSync(MASTER), { type: "buffer" });
function readTab(sheetName, status) {
  const aoa = XLSX.utils.sheet_to_json(mwb.Sheets[sheetName], { header: 1, defval: "", raw: false });
  const hi = aoa.findIndex((row) => String(row[0]).trim().toLowerCase() === "first name");
  const out = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const [fn, em, ps] = aoa[i];
    if (!em && !fn) continue;
    const e = email(em);
    out.push({ status, first_name: String(fn).trim(), email: e,
      party_size: parseInt(digits(ps), 10) || 1, mobile: mobByEmail.get(e) || "" });
  }
  return out;
}
const confName = mwb.SheetNames.find((s) => /confirmed/i.test(s));
const waitName = mwb.SheetNames.find((s) => /waitlist|not selected/i.test(s));
const confirmed = confName ? readTab(confName, "confirmed") : [];
const waitlist = waitName ? readTab(waitName, "waitlist") : [];

const seats = (a) => a.reduce((s, g) => s + g.party_size, 0);
const noMob = (a) => a.filter((g) => g.mobile.length !== 8);

console.log("\n══════════════ masterlist merge (dry-run) ══════════════");
console.log(`  RSVP rows: ${rrows.length}  ·  unique emails with a mobile: ${mobByEmail.size}`);
console.log(`  CONFIRMED: ${confirmed.length} people / ${seats(confirmed)} heads  ·  missing mobile: ${noMob(confirmed).length}`);
console.log(`  WAITLIST : ${waitlist.length} people / ${seats(waitlist)} heads  ·  missing mobile: ${noMob(waitlist).length}`);
for (const g of [...noMob(confirmed), ...noMob(waitlist)].slice(0, 25))
  console.log(`    ⚠ no mobile: ${(g.status).padEnd(9)} ${(g.first_name || "").padEnd(14)} ${g.email}`);

const cell = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const all = [...confirmed, ...waitlist];
const csv = [["status", "first_name", "email", "party_size", "mobile", "wa_phone"].join(",")]
  .concat(all.map((g) => [g.status, g.first_name, g.email, g.party_size, g.mobile, g.mobile ? "974" + g.mobile : ""].map(cell).join(",")));
fs.writeFileSync(OUT, csv.join("\n"));
console.log(`\n  ✓ wrote ${OUT} — ${all.length} rows (${confirmed.length} confirmed + ${waitlist.length} waitlist)\n`);
