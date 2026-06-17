# 🥊 Two solutions, head-to-head

This repo now contains **two independent implementations** of the same QR
movie-night check-in app. They expose the same endpoints and the same guest
experience, but make opposite architectural bets. This doc explains what each
is, shows measured results from running both, and recommends **which to use for
which job**.

| | **Solution A — "Server"** | **Solution B — "Lite / Edge"** |
|---|---|---|
| Location | repo root (`server.js`, `db.js`, `public/`) | [`lite/`](./lite) |
| Stack | Express + `better-sqlite3` + bcrypt + multer + qrcode | Pure Node `http`, **zero runtime deps** |
| Storage | SQLite file (WAL) | JSON file (atomic write), loaded in memory |
| Admin auth | Server-side session + signed cookie (**stateful**) | HMAC bearer token (**stateless**, no session store) |
| Password hash | bcrypt | Node built-in `scrypt` |
| QR code | rendered server-side (PNG) | rendered client-side (admin browser) |
| Bulk import | CSV **file upload** (multer) or paste | CSV read in the browser, posted as text |
| Default port | 3000 | 4000 |
| Install | `npm install` (compiles a native module) | nothing to install |

---

## ✅ Functional parity — verified

Both pass the **same 14-check suite** (`test-compare.mjs`), adapting only the
auth mechanism (cookie vs bearer):

```
--- A (Express+SQLite) ---   14 passed, 0 failed
--- B (Lite/Edge) ---        14 passed, 0 failed
```

Covered: admin endpoints reject anonymous callers · login · CSV import · stats ·
mobile-number normalization (messy `+974 5512-3456` matches) · private-field
hiding (guests never see `id`/`created_at`) · unknown-number 404 · check-in ·
**idempotent** duplicate check-in · search · re-import updates instead of
duplicating · reset · delete.

**Conclusion: for a normal-sized event they behave identically.** The right
choice is about *deployment and scale*, not features.

---

## 📊 Performance — measured

Run with `bench.mjs` (concurrent admin writes hit the storage engine directly).

### Small dataset — 500 guests, 300 concurrent writes
| | import | concurrent writes | integrity |
|---|---|---|---|
| A | 500 rows / 10 ms | **626 ops/s** | ✅ no lost updates |
| B | 500 rows / 11 ms | **607 ops/s** | ✅ no lost updates |

→ **A tie at small scale.** Either is fine for a few hundred guests.

### Large dataset — ~5,800 rows, 500 concurrent writes
| | concurrent writes | on-disk size | integrity |
|---|---|---|---|
| A (SQLite) | **715 ops/s** | 151 KB | ✅ |
| B (JSON file) | **186 ops/s** (~3.8× slower) | 1.19 MB (~8×) | ✅ |

→ B slows down because **every write re-serializes the whole JSON file** (O(n)
per write). SQLite updates one row. Both still lose zero updates — Node is
single-threaded and the writes are synchronous — so B is *correct*, just not
*fast* at scale.

### A real limitation found by testing
Solution A's `express.json()` uses the **default 100 KB body limit**, so a large
*pasted* import (a 144 KB / 5,000-row paste) is rejected with **HTTP 413**.
Solution A's intended big-list path is the **CSV file upload** (multer, 2 MB),
which is unaffected. Solution B accepts the same 144 KB paste (`{"imported":5000}`)
because it sets a 2 MB read limit.
*(One-line fix for A: `express.json({ limit: '2mb' })`.)*

---

## 🎯 Which is best — by use case

### Pick **Solution A (Server + SQLite)** when…
- It's a **real venue with a manned check-in desk** and a box you control.
- The guest list is **large** (thousands) or you re-import/edit a lot.
- You want **durability** (WAL journaling), efficient search, and a
  server-rendered QR that works with no internet on the admin device.
- You can run `npm install` (it compiles `better-sqlite3`) and **attach a
  persistent disk** so the DB survives restarts.

**Watch-outs:** native build step; in-memory sessions mean a single instance
(or a shared session store) — it doesn't horizontally scale as-is; needs a
persistent volume (don't run it on an ephemeral filesystem).

### Pick **Solution B (Lite / Edge)** when…
- You want to **deploy in seconds with zero build** — no native modules, no
  `npm install`. Drop it on a Raspberry Pi, a laptop, a phone (Termux), or a
  cheap function host.
- The event is **small-to-medium** (up to a few thousand guests, light write
  volume).
- You value **stateless auth**: any instance verifies a bearer token with no
  shared session store, which suits serverless/edge and rolling restarts.
- You can't compile native code or can't attach a persistent disk.

**Watch-outs:** the JSON file is rewritten on every write, so it **doesn't scale
to large or write-heavy** lists; the rate limiter and the data file are
**per-instance**, so true horizontal scaling needs a shared datastore behind it
(swap `store.js` for Postgres/Redis). QR rendering needs the admin browser to
load a small CDN script (the guest page needs nothing).

---

## 🔁 The honest one-liner

> **Same app, opposite bets.** A optimizes for a robust single box that scales to
> a big guest list; B optimizes for being tiny, dependency-free, and trivial to
> deploy anywhere. For a normal event both work and pass the same tests — choose
> A if the list is large or you want durability on a server you run, choose B if
> you want to stand it up instantly with nothing to install.

---

## 🧪 Reproduce it

```bash
# Solution A
npm install
DB_PATH=/tmp/a.db PORT=3000 ADMIN_PASSWORD=admin123 npm start

# Solution B (no install needed)
DB_PATH=/tmp/b.json PORT=4000 ADMIN_PASSWORD=admin123 node lite/server.js

# Functional parity (14 checks each)
node test-compare.mjs http://localhost:3000 cookie
node test-compare.mjs http://localhost:4000 bearer

# Throughput / integrity benchmark: <baseUrl> <cookie|bearer> <numGuests> <concurrentWrites>
node bench.mjs http://localhost:3000 cookie 5000 500
node bench.mjs http://localhost:4000 bearer 5000 500
```
