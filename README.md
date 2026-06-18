# QNB Movie Night — Check-in App

A tiny, robust check-in system for the QNB Movie Night screening
(**Toy Story 5 · Sat 20 June 2026 · Novo Cinemas, Doha Oasis**).

Two pages, one Supabase backend, zero server to babysit:

| Page | Who | What |
|------|-----|------|
| `index.html` | Guests | Enter mobile → verify → get a QR ticket (works offline once loaded) |
| `scan.html`  | Organizers | PIN gate → camera scans the QR → admits / flags already-checked-in |

- **Frontend:** static HTML/CSS/JS on **GitHub Pages**. No build step.
- **Backend:** **Supabase** (Postgres). The browser only ever holds the public
  anon key; everything goes through two locked-down RPCs.

---

## Architecture & security

```
 Guest phone ──(anon key)──► verify_guest(mobile)  ─┐
 Organizer  ──(anon key)──► check_in(token, pin)  ─┤   Supabase
                                                    └─► guests / app_config
 Importer  ──(service-role key, .env only)────────────► guests  (bulk upsert)
```

- **RLS blocks all table reads/writes** for the anon (and authenticated) roles.
  The guest list and the PIN are unreachable with the public key — verified:
  `GET /rest/v1/guests` → `permission denied`.
- All guest access is via two `SECURITY DEFINER` RPCs:
  - `verify_guest(p_mobile)` → `{ found, status, name, guest_count, hall, ticket_token, checked_in }`
    (`guest_count` / `hall` / `ticket_token` are `null` unless `status='confirmed'`).
  - `check_in(p_token, p_pin)` → `{ valid, authorized, already_checked_in, name, hall, guest_count, checked_in_at }`.
    PIN-gated; the admit is an **atomic** `UPDATE … WHERE checked_in=false`, so a
    double-scan can never double-admit.
- **Mobile normalisation** is identical in SQL (`normalize_mobile`) and JS:
  strip non-digits, keep the **last 8** (Qatari mobiles; `+974` / spaces / `00974` fold).
- The **service-role key never touches `js/` or git** — it lives only in `.env`.

---

## Repo layout

```
index.html         verify flow + ticket (states from the design)
scan.html          organizer scanner
css/styles.css     design tokens + components (dark cinema/ticket)
js/config.js       Supabase URL + anon key only (public, committed)
js/verify.js       mobile → verify_guest → render ticket + QR
js/scan.js         PIN gate → html5-qrcode → check_in → result states
db/schema.sql      locked schema (tables + RLS + RPCs) — apply as-is
scripts/import.mjs Excel → Supabase (service-role; dry-run by default)
.env.example       importer env template (.env is gitignored)
```

---

## Setup

### 1. Database
Apply [`db/schema.sql`](db/schema.sql) to a fresh Supabase project (SQL Editor),
then set the **real** organizer PIN out-of-band (not in git):

```sql
update app_config set value = '<YOUR_PIN>' where key = 'organizer_pin';
```

### 2. Frontend config
Put the project URL + **anon** key in [`js/config.js`](js/config.js). That's it —
the anon key is safe to commit because RLS does the protecting.

### 3. Deploy
GitHub Pages → serve the repo root. Hard-refresh with a cache-buster
(`?v=2`) after each deploy.

---

## Importing the guest list

The importer reads an `.xlsx`/`.csv` export of the RSVP sheet and upserts guests.
It is **dry-run by default** and writes nothing until you pass `--commit`.

```bash
npm install
cp .env.example .env          # add SUPABASE_SERVICE_ROLE_KEY

# 1) Dry-run: prints column mapping, first 5 normalised rows, confirmed/waitlist counts
node scripts/import.mjs --file rsvp.xlsx --hall3 120 --hall4 120

# 2) Once the mapping looks right:
node scripts/import.mjs --file rsvp.xlsx --hall3 120 --hall4 120 --commit
```

Mapping (auto-detected from headers, override-friendly):

| Field | Source column |
|-------|---------------|
| `name` | *Full Name* (falls back to a name derived from *Work Email* when blank/`Yes`/`No`) |
| `mobile` | *Personal Mobile Number* (falls back to *Office Extension Number* if it's a valid 8-digit mobile) |
| `guest_count` | *Total number attending (including you)* — **total party incl. the employee** |
| attending | *Will you be attending?* — only an explicit **No** is excluded |
| `hall` / `status` | assigned by **capacity** (Hall 3 → Hall 4 → waitlist), in sheet order |

**Idempotent:** upsert on conflict `mobile`; re-running preserves each guest's
`ticket_token`, `checked_in`, `checked_in_at`.

---

## Venue resilience (flaky cinema Wi-Fi)

- **Guest:** the loaded ticket is cached in `sessionStorage`, so a dropped signal
  still shows the QR (a screenshot works fully offline — the QR is self-contained).
- **Scanner:** on a network error it shows **No connection — Retry** and never
  silently admits or rejects. The atomic `check_in` resolves any duplicate the
  moment it reaches the server.

---

## Test checklist

1. Number not found → "couldn't find that number"
2. Waitlist guest → waitlist screen (no ticket)
3. Confirmed guest → ticket + scannable QR of the raw token
4. Scan a valid ticket → **Admit**
5. Re-scan the same ticket → **Already checked in** (+ time)
6. Scan garbage → **Invalid ticket**
7. Wrong PIN → blocked (`authorized=false`)
