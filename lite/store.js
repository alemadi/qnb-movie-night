/**
 * Storage layer for the "Lite / Edge" edition.
 *
 * Deliberately has ZERO native/npm dependencies: guests are held in memory and
 * persisted to a single JSON file with atomic writes (write temp + rename).
 * This is what makes the edition trivial to run anywhere Node runs — no
 * compilation step (unlike better-sqlite3), no DB server.
 *
 * Trade-off vs the SQLite edition: a JSON file is loaded/serialized in full and
 * is process-local, so it is ideal for a single check-in device with up to a
 * few thousand guests, not for many writers hammering the same dataset.
 *
 * Guest shape (kept identical to the SQLite edition so the frontends match):
 *   { id, full_name, mobile, seats, status, checked_in_at, created_at }
 */
const fs = require('fs');
const path = require('path');

const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, 'data', 'guests.json');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/**
 * Normalize a mobile number so lookups are consistent regardless of how the
 * guest types it (spaces, dashes, parentheses, leading +). A leading "+" is
 * kept; every other non-digit is stripped. (Identical rule to the SQLite db.js
 * so a guest list works the same in either edition.)
 */
function normalizeMobile(raw) {
  if (raw == null) return '';
  const str = String(raw).trim();
  const hasPlus = str.startsWith('+');
  const digits = str.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

// --- In-memory state, loaded from disk on boot ----------------------------
let guests = [];
let nextId = 1;

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    guests = Array.isArray(parsed.guests) ? parsed.guests : [];
    nextId = parsed.nextId || guests.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  } catch {
    guests = [];
    nextId = 1;
  }
}

// Atomic persist: write a temp file then rename over the real one so a crash
// mid-write can never corrupt the dataset.
function persist() {
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ nextId, guests }, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

load();

function byMobile(mobile) {
  const m = normalizeMobile(mobile);
  return guests.find((g) => g.mobile === m);
}

module.exports = {
  normalizeMobile,

  /** Insert or update a guest (keyed on normalized mobile). Returns the row. */
  upsertGuest({ full_name, mobile, seats }) {
    const m = normalizeMobile(mobile);
    const name = String(full_name || '').trim();
    const s = Number.isFinite(+seats) && +seats > 0 ? Math.floor(+seats) : 1;
    let g = guests.find((x) => x.mobile === m);
    if (g) {
      g.full_name = name;
      g.seats = s;
    } else {
      g = {
        id: nextId++,
        full_name: name,
        mobile: m,
        seats: s,
        status: 'pending',
        checked_in_at: null,
        created_at: new Date().toISOString(),
      };
      guests.push(g);
    }
    persist();
    return g;
  },

  /** Bulk upsert; persists once at the end. Returns the number stored. */
  bulkUpsert(rows) {
    let count = 0;
    for (const r of rows) {
      if (!r.full_name || !r.mobile) continue;
      const m = normalizeMobile(r.mobile);
      const name = String(r.full_name).trim();
      const s = Number.isFinite(+r.seats) && +r.seats > 0 ? Math.floor(+r.seats) : 1;
      let g = guests.find((x) => x.mobile === m);
      if (g) {
        g.full_name = name;
        g.seats = s;
      } else {
        guests.push({
          id: nextId++,
          full_name: name,
          mobile: m,
          seats: s,
          status: 'pending',
          checked_in_at: null,
          created_at: new Date().toISOString(),
        });
      }
      count++;
    }
    persist();
    return count;
  },

  findByMobile(mobile) {
    return byMobile(mobile);
  },

  findById(id) {
    return guests.find((g) => g.id === Number(id));
  },

  /**
   * Attempt to check a guest in.
   * Returns { ok:true, alreadyCheckedIn:false, guest } on success,
   *         { ok:true, alreadyCheckedIn:true, guest } if previously checked in,
   *         { ok:false } if the guest does not exist.
   */
  checkInByMobile(mobile) {
    const g = byMobile(mobile);
    if (!g) return { ok: false };
    if (g.status === 'checked_in') {
      return { ok: true, alreadyCheckedIn: true, guest: g };
    }
    g.status = 'checked_in';
    g.checked_in_at = new Date().toISOString();
    persist();
    return { ok: true, alreadyCheckedIn: false, guest: g };
  },

  resetGuest(id) {
    const g = guests.find((x) => x.id === Number(id));
    if (!g) return null;
    g.status = 'pending';
    g.checked_in_at = null;
    persist();
    return g;
  },

  deleteGuest(id) {
    const i = guests.findIndex((x) => x.id === Number(id));
    if (i === -1) return false;
    guests.splice(i, 1);
    persist();
    return true;
  },

  listGuests(query) {
    const sorted = [...guests].sort((a, b) =>
      a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase())
    );
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      return sorted.filter(
        (g) =>
          g.full_name.toLowerCase().includes(q) ||
          g.mobile.toLowerCase().includes(q)
      );
    }
    return sorted;
  },

  getStats() {
    let total_guests = 0;
    let total_seats = 0;
    let checked_in_guests = 0;
    let checked_in_seats = 0;
    for (const g of guests) {
      total_guests += 1;
      total_seats += g.seats;
      if (g.status === 'checked_in') {
        checked_in_guests += 1;
        checked_in_seats += g.seats;
      }
    }
    return {
      total_guests,
      total_seats,
      checked_in_guests,
      checked_in_seats,
      remaining_guests: total_guests - checked_in_guests,
      remaining_seats: total_seats - checked_in_seats,
    };
  },
};
