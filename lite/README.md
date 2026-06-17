# 🎬 QNB Movie Night — Lite / Edge edition

A second implementation of the [root check-in app](../README.md) that makes the
opposite architectural bet: **zero runtime dependencies and stateless auth**, so
it runs anywhere Node runs with nothing to install and nothing to compile.

See [`../COMPARISON.md`](../COMPARISON.md) for the head-to-head with the
Express + SQLite edition and guidance on which to use.

## What's different

- **Pure Node `http`** — no Express, no framework, **no `node_modules`**.
- **JSON-file storage** (`store.js`) with atomic writes — no native module, no
  build step (the root edition compiles `better-sqlite3`).
- **Stateless admin auth** (`auth.js`): an HMAC-signed bearer token, so the
  server keeps no session state and can be replicated or run serverless. Login
  returns a token; the admin UI stores it in `localStorage` and sends it as
  `Authorization: Bearer …`.
- **Password hashing via Node's built-in `scrypt`** (no bcrypt).
- **QR generated client-side** in the admin browser (keeps the server thin).
- **CSV import is read in the browser** and posted as text (the server takes no
  file uploads), with a 2 MB body limit.

Endpoints, the guest flow, mobile-number normalization, idempotent check-in, and
the admin features are identical to the root edition.

## Run it

```bash
# from the repo root — nothing to install
ADMIN_PASSWORD=admin123 node lite/server.js

# optional: load 5 sample guests
node lite/seed.js
```

Then open:
- Guest check-in: **http://localhost:4000/**
- Admin dashboard: **http://localhost:4000/admin** (password `admin123` by default)

## Configuration (env vars)

| Variable              | Default                | Purpose                                            |
|-----------------------|------------------------|----------------------------------------------------|
| `PORT`                | `4000`                 | Port to listen on                                  |
| `ADMIN_PASSWORD`      | `admin123`             | Plain admin password (scrypt-hashed at startup)    |
| `ADMIN_PASSWORD_HASH` | —                      | Pre-hashed `salt:hash` (takes precedence)          |
| `SESSION_SECRET`      | random                 | HMAC secret for signing bearer tokens — **set in prod** |
| `PUBLIC_URL`          | derived per-request    | Base URL encoded in the QR                         |
| `DB_PATH`             | `lite/data/guests.json`| JSON datastore location                            |

Generate production secrets:

```bash
# a strong token-signing secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# a scrypt password hash ("salt:hash") for ADMIN_PASSWORD_HASH
node -e "const c=require('crypto');const s=c.randomBytes(16);console.log(s.toString('hex')+':'+c.scryptSync('YOUR_PASSWORD',s,32).toString('hex'))"
```

## Scaling note

The JSON datastore is rewritten on every write and is process-local, so this
edition is ideal for a **single device with up to a few thousand guests**. To run
multiple instances behind a load balancer, swap `store.js` for a shared backend
(Postgres/Redis) — the stateless bearer auth already supports horizontal scaling;
the file store is the only piece that doesn't.
