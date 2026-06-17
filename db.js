/**
 * Database layer (SQLite via better-sqlite3).
 *
 * Schema:
 *   guests
 *     id            INTEGER PRIMARY KEY
 *     full_name     TEXT     guest full name
 *     mobile        TEXT     normalized mobile number (unique) — used as the lookup key
 *     seats         INTEGER  number of party members / reserved seats
 *     status        TEXT     'pending' | 'checked_in'
 *     checked_in_at TEXT     ISO timestamp of check-in (null until confirmed)
 *     created_at    TEXT     ISO timestamp the row was added
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'checkin.db');

// Ensure the data directory exists.
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT    NOT NULL,
    mobile        TEXT    NOT NULL UNIQUE,
    seats         INTEGER NOT NULL DEFAULT 1,
    status        TEXT    NOT NULL DEFAULT 'pending',
    checked_in_at TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_guests_mobile ON guests(mobile);
`);

/**
 * Normalize a mobile number so that lookups are consistent regardless of how
 * the guest types it (spaces, dashes, parentheses, leading +). We keep a
 * leading "+" if present and strip every other non-digit character.
 */
function normalizeMobile(raw) {
  if (raw == null) return '';
  const str = String(raw).trim();
  const hasPlus = str.startsWith('+');
  const digits = str.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

const statements = {
  insertGuest: db.prepare(`
    INSERT INTO guests (full_name, mobile, seats)
    VALUES (@full_name, @mobile, @seats)
    ON CONFLICT(mobile) DO UPDATE SET
      full_name = excluded.full_name,
      seats     = excluded.seats
  `),
  findByMobile: db.prepare(`SELECT * FROM guests WHERE mobile = ?`),
  findById: db.prepare(`SELECT * FROM guests WHERE id = ?`),
  checkIn: db.prepare(`
    UPDATE guests
    SET status = 'checked_in', checked_in_at = datetime('now')
    WHERE id = ? AND status != 'checked_in'
  `),
  resetGuest: db.prepare(`
    UPDATE guests SET status = 'pending', checked_in_at = NULL WHERE id = ?
  `),
  deleteGuest: db.prepare(`DELETE FROM guests WHERE id = ?`),
  allGuests: db.prepare(`SELECT * FROM guests ORDER BY full_name COLLATE NOCASE ASC`),
  searchGuests: db.prepare(`
    SELECT * FROM guests
    WHERE full_name LIKE @q OR mobile LIKE @q
    ORDER BY full_name COLLATE NOCASE ASC
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*)                                                AS total_guests,
      COALESCE(SUM(seats), 0)                                 AS total_seats,
      COALESCE(SUM(CASE WHEN status='checked_in' THEN 1 ELSE 0 END), 0)         AS checked_in_guests,
      COALESCE(SUM(CASE WHEN status='checked_in' THEN seats ELSE 0 END), 0)     AS checked_in_seats
    FROM guests
  `),
};

module.exports = {
  db,
  normalizeMobile,

  /** Insert or upsert a guest. Returns the stored row. */
  upsertGuest({ full_name, mobile, seats }) {
    const normalized = normalizeMobile(mobile);
    statements.insertGuest.run({
      full_name: String(full_name || '').trim(),
      mobile: normalized,
      seats: Number.isFinite(+seats) && +seats > 0 ? Math.floor(+seats) : 1,
    });
    return statements.findByMobile.get(normalized);
  },

  /** Bulk insert inside a single transaction. Returns counts. */
  bulkUpsert(rows) {
    const run = db.transaction((items) => {
      let count = 0;
      for (const r of items) {
        if (!r.full_name || !r.mobile) continue;
        module.exports.upsertGuest(r);
        count++;
      }
      return count;
    });
    return run(rows);
  },

  findByMobile(mobile) {
    return statements.findByMobile.get(normalizeMobile(mobile));
  },

  findById(id) {
    return statements.findById.get(id);
  },

  /**
   * Attempt to check a guest in.
   * Returns { ok: true, alreadyCheckedIn: false, guest } on success,
   *         { ok: true, alreadyCheckedIn: true, guest } if previously checked in,
   *         { ok: false } if the guest does not exist.
   */
  checkInByMobile(mobile) {
    const guest = module.exports.findByMobile(mobile);
    if (!guest) return { ok: false };
    if (guest.status === 'checked_in') {
      return { ok: true, alreadyCheckedIn: true, guest };
    }
    statements.checkIn.run(guest.id);
    return { ok: true, alreadyCheckedIn: false, guest: statements.findById.get(guest.id) };
  },

  resetGuest(id) {
    statements.resetGuest.run(id);
    return statements.findById.get(id);
  },

  deleteGuest(id) {
    return statements.deleteGuest.run(id).changes > 0;
  },

  listGuests(query) {
    if (query && query.trim()) {
      return statements.searchGuests.all({ q: `%${query.trim()}%` });
    }
    return statements.allGuests.all();
  },

  getStats() {
    const s = statements.stats.get();
    return {
      total_guests: s.total_guests,
      total_seats: s.total_seats,
      checked_in_guests: s.checked_in_guests,
      checked_in_seats: s.checked_in_seats,
      remaining_guests: s.total_guests - s.checked_in_guests,
      remaining_seats: s.total_seats - s.checked_in_seats,
    };
  },
};
