#!/usr/bin/env node
/* ============================================================================
 * QNB Movie Night — guest list importer
 * ----------------------------------------------------------------------------
 * Reads the RSVP spreadsheet (.xlsx / .csv export of the Google Sheet) and
 * upserts guests into Supabase. Uses the SERVICE-ROLE key (RLS-bypassing) which
 * must live ONLY in a gitignored .env — never in js/ or git.
 *
 * Safety:
 *   - Defaults to --dry-run: prints the column mapping, the first 5 normalised
 *     rows and confirmed/waitlist counts, and writes NOTHING.
 *   - --commit is required to actually write.
 *
 * Idempotency:
 *   - Upsert on conflict(mobile). The payload only carries
 *     name / guest_count / hall / status, so re-running PRESERVES each row's
 *     ticket_token, checked_in and checked_in_at.
 *
 * Mobile normalisation matches the DB normalize_mobile(): strip every non-digit
 * and keep the LAST 8 digits (Qatari mobiles; +974 / spaces / 00974 all fold).
 *
 * Usage:
 *   node scripts/import.mjs                       # dry-run, ./guests.xlsx
 *   node scripts/import.mjs --file rsvp.xlsx      # dry-run a specific file
 *   node scripts/import.mjs --sheet "Form Responses 1"
 *   node scripts/import.mjs --hall3 120 --hall4 120   # hall capacities
 *   node scripts/import.mjs --commit              # write to Supabase
 * ==========================================================================*/

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import "dotenv/config";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const COMMIT = argv.includes("--commit");
const DRY = !COMMIT; // dry-run unless --commit
const FILE = String(flag("file", "guests.xlsx"));
const SHEET = flag("sheet", null);
// Hall capacities are OPTIONAL. If neither is given we run in GATE mode:
// everyone attending is imported as confirmed with NO pre-assigned hall, and
// the hall is chosen at the door scanner. Provide --hall3 N --hall4 N to instead
// pre-allocate by capacity (Hall 3, then Hall 4, then waitlist).
const _h3 = flag("hall3", null);
const _h4 = flag("hall4", null);
const HALL3_CAP = _h3 != null && _h3 !== true ? Number(_h3) : null;
const HALL4_CAP = _h4 != null && _h4 !== true ? Number(_h4) : null;
const GATE_MODE = HALL3_CAP == null || HALL4_CAP == null;
const HALL3_NAME = String(flag("hall3-name", "Hall 3"));
const HALL4_NAME = String(flag("hall4-name", "Hall 4"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const die = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

/** Same rule as the DB normalize_mobile(): digits only, last 8. */
function normalizeMobile(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.slice(-8);
}

function titleCaseFromEmail(email) {
  const local = String(email || "").split("@")[0] || "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

/** Find a column key whose header loosely matches any of the needles. */
function findCol(headers, needles) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const n of needles) {
    const key = headers.find((h) => norm(h).includes(norm(n)));
    if (key) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load sheet
// ---------------------------------------------------------------------------
const filePath = path.resolve(process.cwd(), FILE);
if (!fs.existsSync(filePath)) {
  die(`File not found: ${filePath}\n  Export the RSVP Google Sheet as .xlsx (or .csv) and pass --file <path>.`);
}
const wb = XLSX.read(fs.readFileSync(filePath), { type: "buffer" });
const sheetName = SHEET && wb.SheetNames.includes(SHEET) ? SHEET : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "", raw: false });
if (!rows.length) die(`Sheet "${sheetName}" has no rows.`);

const headers = Object.keys(rows[0]);
const colName = findCol(headers, ["Full Name", "Name"]);
const colEmail = findCol(headers, ["Work Email", "Email"]);
const colMobile = findCol(headers, ["Personal Mobile", "Mobile", "Phone"]);
const colExt = findCol(headers, ["Office Extension", "Extension"]);
const colCount = findCol(headers, ["Total number attending", "Total attending", "number attending"]);
const colAttend = findCol(headers, ["Will you be attending", "Attending"]);

// ---------------------------------------------------------------------------
// Transform rows -> guests
// ---------------------------------------------------------------------------
const YES_NO = /^(yes|no)\b/i;
function cleanName(row) {
  let n = String(row[colName] || "").trim();
  if (!n || YES_NO.test(n) || /count me in/i.test(n)) n = "";
  if (!n && colEmail) n = titleCaseFromEmail(row[colEmail]);
  return n || "Guest";
}
function pickMobile(row) {
  // Prefer the mobile column; if it normalises to <8, try the extension column.
  let m = normalizeMobile(row[colMobile]);
  if (m.length < 8 && colExt) {
    const ext = normalizeMobile(row[colExt]);
    if (ext.length === 8) m = ext;
  }
  return m;
}
function pickCount(row) {
  const raw = String(row[colCount] || "").replace(/\D/g, "");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function isAttending(row) {
  // In early form responses the Yes/No answer landed in the *Full Name* column,
  // so check both. Only an explicit "No" (in either) excludes; blanks count as
  // attending (most rows leave the attending column empty).
  const a = String(row[colAttend] || "").trim().toLowerCase();
  const n = colName ? String(row[colName] || "").trim().toLowerCase() : "";
  return a !== "no" && n !== "no";
}

const seen = new Set();
const guests = [];
let skippedNoMobile = 0;
let skippedNotAttending = 0;
let dupes = 0;

for (const row of rows) {
  if (!isAttending(row)) { skippedNotAttending++; continue; }
  const mobile = pickMobile(row);
  if (mobile.length !== 8) { skippedNoMobile++; continue; }
  if (seen.has(mobile)) { dupes++; continue; } // first occurrence wins
  seen.add(mobile);
  guests.push({
    mobile,
    name: cleanName(row),
    guest_count: pickCount(row),
    _email: colEmail ? String(row[colEmail] || "") : "",
  });
}

// ---------------------------------------------------------------------------
// Status / hall assignment.
//   GATE mode (default): everyone attending is confirmed, hall left NULL — the
//     door scanner assigns Hall 3/4 on arrival.
//   Capacity mode (--hall3 N --hall4 N): fill Hall 3, then Hall 4 (by seats, in
//     RSVP order); the overflow becomes waitlist.
// ---------------------------------------------------------------------------
let used3 = 0, used4 = 0;
if (GATE_MODE) {
  for (const g of guests) { g.status = "confirmed"; g.hall = null; }
} else {
  for (const g of guests) {
    if (used3 + g.guest_count <= HALL3_CAP) { g.status = "confirmed"; g.hall = HALL3_NAME; used3 += g.guest_count; }
    else if (used4 + g.guest_count <= HALL4_CAP) { g.status = "confirmed"; g.hall = HALL4_NAME; used4 += g.guest_count; }
    else { g.status = "waitlist"; g.hall = null; }
  }
}

const confirmed = guests.filter((g) => g.status === "confirmed");
const waitlist = guests.filter((g) => g.status === "waitlist");
const seats = (arr) => arr.reduce((s, g) => s + g.guest_count, 0);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
log("\n══════════════════════════════════════════════════════════════");
log("  QNB Movie Night — guest importer");
log("══════════════════════════════════════════════════════════════");
log(`  File           : ${filePath}`);
log(`  Sheet          : ${sheetName}  (${rows.length} rows)`);
log(`  Mode           : ${DRY ? "DRY-RUN (no writes)" : "COMMIT (writing to Supabase)"}`);
log("\n  Column mapping:");
log(`    name         <- ${colName || "(derived from email)"}`);
log(`    mobile       <- ${colMobile || "(none!)"}${colExt ? `  (fallback: ${colExt})` : ""}`);
log(`    guest_count  <- ${colCount || "(default 1)"}`);
log(`    attending    <- ${colAttend || "(all attending)"}`);
log(`    email        <- ${colEmail || "(none)"}`);
log("\n  Hall assignment:");
log(GATE_MODE
  ? `    GATE mode — everyone confirmed, hall assigned at the door (set --hall3 N --hall4 N to pre-allocate instead)`
  : `    Capacity mode — ${HALL3_NAME}: ${HALL3_CAP} seats  |  ${HALL4_NAME}: ${HALL4_CAP} seats  (overflow -> waitlist)`);

log("\n  First 5 normalised rows:");
log("    " + ["mobile".padEnd(10), "count", "hall".padEnd(8), "status".padEnd(10), "name"].join("  "));
for (const g of guests.slice(0, 5)) {
  log("    " + [g.mobile.padEnd(10), String(g.guest_count).padEnd(5), String(g.hall || "—").padEnd(8), g.status.padEnd(10), g.name].join("  "));
}

log("\n  Counts:");
log(`    guests parsed      : ${guests.length}`);
log(`    confirmed          : ${confirmed.length} guests / ${seats(confirmed)} seats`);
log(`    waitlist           : ${waitlist.length} guests / ${seats(waitlist)} seats`);
log(`    skipped (no mobile): ${skippedNoMobile}`);
log(`    skipped (said No)  : ${skippedNotAttending}`);
log(`    duplicate mobiles  : ${dupes}`);
log("══════════════════════════════════════════════════════════════");

if (DRY) {
  log("\n  Dry-run only — nothing written. Re-run with --commit to import.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Commit to Supabase
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).");
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const payload = guests.map(({ mobile, name, guest_count, status, hall }) => ({
  mobile, name, guest_count, status, hall,
  wa_phone: "974" + mobile, // Qatari E.164 (cc + national) for WhatsApp / links
}));

log(`\n  Upserting ${payload.length} guests (on conflict: mobile, preserving token/check-in)…`);
const CHUNK = 500;
let written = 0;
for (let i = 0; i < payload.length; i += CHUNK) {
  const slice = payload.slice(i, i + CHUNK);
  const { error, count } = await supabase
    .from("guests")
    .upsert(slice, { onConflict: "mobile", count: "exact" });
  if (error) die(`Upsert failed at chunk ${i / CHUNK}: ${error.message}`);
  written += count ?? slice.length;
  log(`    …${Math.min(i + CHUNK, payload.length)}/${payload.length}`);
}
log(`\n  ✓ Done. ${written} rows upserted.\n`);
