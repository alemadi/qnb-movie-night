# 🎬 QNB Movie Night — QR Check-In

A simple, mobile-friendly web app to check guests in at a movie screening using a
QR code. Guests scan a QR poster at the entrance, enter the mobile number they
reserved with, confirm their booking, and tap **Confirm Check-In**. Admins manage
the guest list and watch live attendance from a password-protected dashboard.

Built to be tiny and self-contained: **Node.js + Express + SQLite** with a plain
HTML/CSS/JS frontend (no build step).

> **Two editions available.** This is the **Server** edition (Express + SQLite).
> A second, **Lite / Edge** edition lives in [`lite/`](./lite) — zero runtime
> dependencies and stateless auth, for instant deploy anywhere. See
> [`COMPARISON.md`](./COMPARISON.md) for a tested head-to-head and which to use
> for which job.

---

## ✨ Features

**Guest check-in page** (the QR code points here)
- Enter mobile number → see your booking (name, mobile, seats, status)
- Tap **Confirm Check-In** → status becomes *Checked In* and the time is recorded
- Duplicate-proof: scanning again shows *"You're already checked in"*
- Guests can only see their own details, and only after entering the right number

**Admin dashboard** (`/admin`, password protected)
- Live totals: registered guests, seats reserved, checked-in, remaining
- Search by name or mobile number
- Add guests one at a time, or bulk import a CSV / pasted list
- See each guest's status (Pending / Checked In) and check-in time
- Manually check in, undo a check-in, or delete a guest
- Generate & print the entrance QR poster

**Security basics**
- Admin login with a bcrypt-hashed password and signed session cookies
- Rate limiting on guest lookups (anti brute-force) and admin login
- Guest API only ever returns the single matching guest's own fields

---

## 🗄️ Database structure

One table, `guests` (SQLite):

| Column          | Type    | Notes                                            |
|-----------------|---------|--------------------------------------------------|
| `id`            | INTEGER | Primary key                                      |
| `full_name`     | TEXT    | Guest full name                                  |
| `mobile`        | TEXT    | **Unique** — normalized lookup key               |
| `seats`         | INTEGER | Party members / reserved seats                   |
| `status`        | TEXT    | `pending` or `checked_in`                        |
| `checked_in_at` | TEXT    | ISO timestamp, set on check-in                   |
| `created_at`    | TEXT    | When the row was added                           |

Mobile numbers are **normalized** before storing/looking up — spaces, dashes and
parentheses are stripped (a leading `+` is kept) — so `+974 5512-3456`,
`+97455123456`, etc. all match the same guest. This is also what prevents
duplicate guest rows and duplicate check-ins.

---

## 🚀 Run it locally

**Prerequisites:** Node.js 18+ (tested on Node 22).

```bash
# 1. Install dependencies
npm install

# 2. (Optional) configure environment — set an admin password etc.
cp .env.example .env
#   then edit .env (default admin password is "admin123")

# 3. (Optional) load 5 sample guests so you have data to play with
npm run seed

# 4. Start the server
npm start
```

Then open:

- Guest check-in: **http://localhost:3000/**
- Admin dashboard: **http://localhost:3000/admin** (password: `admin123` by default)

> Use `npm run dev` instead of `npm start` to auto-restart on file changes.

### Try the full flow locally
1. Open `/admin`, log in, go to **Add / Import**, and import `sample-guests.csv`
   (or paste a few `name, mobile, seats` lines).
2. Open the **QR Code** tab — that QR encodes your check-in URL.
3. On your phone (same Wi-Fi), browse to `http://<your-computer-ip>:3000/`,
   enter a guest's mobile number, and confirm check-in.
4. Watch the dashboard totals update.

---

## 📥 Importing a guest list

In the dashboard's **Add / Import** tab you can either upload a `.csv` file or
paste rows. Accepted format (a header row is optional, columns can be in any
order when a header is present):

```csv
Full Name, Mobile, Seats
Sara Ahmed, +97455123456, 2
Khalid Al-Thani, +97466778899, 4
```

Re-importing a mobile number **updates** that guest instead of creating a
duplicate. A ready-made `sample-guests.csv` is included.

---

## 🔗 QR code

The QR code (Admin → **QR Code** tab) encodes the public check-in URL. Locally
that's `http://localhost:3000/`; once deployed it uses your real domain.

> Phones can't reach `localhost` over a printed QR. For a real event, **set
> `PUBLIC_URL`** to your deployed HTTPS URL (see below) so the generated QR points
> somewhere guests' phones can actually open. Use **Print QR poster** to print it.

---

## 🔐 Configuration (environment variables)

All optional — sensible defaults are used for local dev. See `.env.example`.

| Variable               | Default        | Purpose                                                        |
|------------------------|----------------|----------------------------------------------------------------|
| `PORT`                 | `3000`         | Port to listen on                                              |
| `ADMIN_PASSWORD`       | `admin123`     | Plain admin password (hashed at startup)                       |
| `ADMIN_PASSWORD_HASH`  | —              | Pre-hashed bcrypt password (takes precedence; best for prod)   |
| `SESSION_SECRET`       | random         | Secret for signing session cookies — **set this in prod**      |
| `PUBLIC_URL`           | derived        | Public base URL used for the QR target                         |
| `DB_PATH`              | `./data/checkin.db` | SQLite file location                                      |
| `NODE_ENV`             | —              | Set to `production` to enable secure cookies                   |

Generate production secrets:

```bash
# bcrypt hash of your admin password
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 10))"
# a strong session secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## ☁️ Deploy online

The app is a standard Node web server with a SQLite file on disk, so any host
that runs Node **and gives you a persistent disk** works well. Below are two easy
options. After deploying, set `PUBLIC_URL` to your live URL and re-open the
dashboard so the QR poster points to the right place.

### Option A — Railway (simplest, has persistent volumes)
1. Push this repo to GitHub.
2. On [railway.app](https://railway.app): **New Project → Deploy from GitHub repo**.
3. Add a **Volume** mounted at `/app/data` (so the SQLite DB survives restarts).
4. Add environment variables:
   - `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`)
   - `SESSION_SECRET`
   - `NODE_ENV=production`
   - `DB_PATH=/app/data/checkin.db`
   - `PUBLIC_URL=https://<your-app>.up.railway.app`
5. Railway runs `npm install` then `npm start` automatically. Open the URL.

### Option B — Render
1. Push to GitHub, then on [render.com](https://render.com): **New → Web Service**.
2. Build command `npm install`, start command `npm start`.
3. Add a **Disk** mounted at `/var/data` and set `DB_PATH=/var/data/checkin.db`.
4. Set the same env vars as above (with the Render URL for `PUBLIC_URL`).

> ⚠️ **Persistent disk matters.** Platforms with ephemeral filesystems (e.g. a
> plain Heroku dyno, some serverless tiers) will wipe `checkin.db` on every
> restart/redeploy. Always attach a volume/disk and point `DB_PATH` at it.

### Want a hosted database instead of SQLite (Supabase)?
SQLite is perfect for a single venue. If you'd rather use a managed Postgres so
multiple instances can share data, create a Supabase project with this table and
swap `db.js` to query it — the rest of the app is unchanged:

```sql
create table guests (
  id            bigint generated always as identity primary key,
  full_name     text not null,
  mobile        text not null unique,
  seats         integer not null default 1,
  status        text not null default 'pending',
  checked_in_at timestamptz,
  created_at    timestamptz not null default now()
);
```

---

## 📁 Project structure

```
.
├── server.js          # Express server: guest + admin APIs, QR, auth
├── db.js              # SQLite schema + all data access helpers
├── seed.js            # Loads sample guests (npm run seed)
├── sample-guests.csv  # Example import file
├── .env.example       # Copy to .env and configure
└── public/
    ├── index.html     # Guest check-in page (QR points here)
    ├── admin.html     # Admin dashboard
    ├── css/styles.css # Responsive, mobile-first styling
    └── js/
        ├── checkin.js # Guest flow logic
        └── admin.js   # Dashboard logic
```

## 🧰 API reference (quick)

| Method | Endpoint                       | Auth   | Purpose                          |
|--------|--------------------------------|--------|----------------------------------|
| POST   | `/api/lookup`                  | public | Find a guest by mobile           |
| POST   | `/api/checkin`                 | public | Confirm check-in (idempotent)    |
| POST   | `/api/admin/login` / `logout`  | —      | Admin session                    |
| GET    | `/api/admin/stats`             | admin  | Dashboard totals                 |
| GET    | `/api/admin/guests?q=`         | admin  | List / search guests             |
| POST   | `/api/admin/guests`            | admin  | Add one guest                    |
| POST   | `/api/admin/import`            | admin  | Bulk import (file or text)       |
| POST   | `/api/admin/guests/:id/reset`  | admin  | Undo a check-in                  |
| DELETE | `/api/admin/guests/:id`        | admin  | Delete a guest                   |
| GET    | `/api/admin/qr`                | admin  | QR code PNG                      |
