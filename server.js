/**
 * QNB Movie Night — QR check-in server.
 *
 * Public guest flow:
 *   GET  /                     -> guest check-in page (the QR code points here)
 *   POST /api/lookup           -> find a guest by mobile number
 *   POST /api/checkin          -> confirm check-in for a mobile number
 *
 * Admin flow (password protected):
 *   GET  /admin                -> dashboard (or login page if not authenticated)
 *   POST /api/admin/login      -> start an admin session
 *   POST /api/admin/logout     -> end the admin session
 *   GET  /api/admin/stats      -> dashboard totals
 *   GET  /api/admin/guests     -> list / search guests
 *   POST /api/admin/guests     -> add a single guest
 *   POST /api/admin/import     -> bulk import (CSV file or pasted text)
 *   POST /api/admin/guests/:id/reset  -> undo a check-in
 *   DELETE /api/admin/guests/:id      -> remove a guest
 *   GET  /api/admin/qr         -> PNG QR code that links to the check-in page
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const store = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration --------------------------------------------------------
// Admin password: provide either ADMIN_PASSWORD_HASH (bcrypt) or ADMIN_PASSWORD
// (plain, hashed once at startup). Falls back to "admin123" for local dev only.
const ADMIN_PASSWORD_HASH =
  process.env.ADMIN_PASSWORD_HASH ||
  bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

const SESSION_SECRET =
  process.env.SESSION_SECRET || 'change-me-in-production-' + Math.random();

// PUBLIC_URL is used to build the QR target. If not set we derive it per-request.
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// --- Middleware -----------------------------------------------------------
app.set('trust proxy', 1); // correct client IPs / secure cookies behind a proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Throttle guest endpoints so the mobile-number lookup can't be brute-forced.
const guestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Unauthorized. Please log in as admin.' });
}

// Only expose the fields a guest is allowed to see about themselves.
function publicGuestView(guest) {
  return {
    full_name: guest.full_name,
    mobile: guest.mobile,
    seats: guest.seats,
    status: guest.status,
    checked_in_at: guest.checked_in_at,
  };
}

// --- Static frontend ------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// Guest API
// =========================================================================

// Look up a guest by mobile number (does NOT check them in).
app.post('/api/lookup', guestLimiter, (req, res) => {
  const mobile = req.body && req.body.mobile;
  if (!mobile || !String(mobile).trim()) {
    return res.status(400).json({ error: 'Please enter your mobile number.' });
  }
  const guest = store.findByMobile(mobile);
  if (!guest) {
    return res.status(404).json({
      error: 'No reservation found for that mobile number. Please check the number or see a staff member.',
    });
  }
  res.json({ guest: publicGuestView(guest) });
});

// Confirm check-in. Idempotent: a second scan reports "already checked in".
app.post('/api/checkin', guestLimiter, (req, res) => {
  const mobile = req.body && req.body.mobile;
  if (!mobile || !String(mobile).trim()) {
    return res.status(400).json({ error: 'Please enter your mobile number.' });
  }
  const result = store.checkInByMobile(mobile);
  if (!result.ok) {
    return res.status(404).json({
      error: 'No reservation found for that mobile number.',
    });
  }
  res.json({
    alreadyCheckedIn: result.alreadyCheckedIn,
    guest: publicGuestView(result.guest),
  });
});

// =========================================================================
// Admin API
// =========================================================================

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = req.body && req.body.password;
  if (!password || !bcrypt.compareSync(String(password), ADMIN_PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(store.getStats());
});

app.get('/api/admin/guests', requireAdmin, (req, res) => {
  const guests = store.listGuests(req.query.q || '');
  res.json({ guests });
});

app.post('/api/admin/guests', requireAdmin, (req, res) => {
  const { full_name, mobile, seats } = req.body || {};
  if (!full_name || !mobile) {
    return res.status(400).json({ error: 'Full name and mobile number are required.' });
  }
  const guest = store.upsertGuest({ full_name, mobile, seats });
  res.json({ guest });
});

/**
 * Parse pasted/uploaded guest data. Accepts CSV with a header row containing
 * name / mobile / seats columns (in any order, case-insensitive) OR simple
 * lines of "name, mobile, seats".
 */
function parseGuestText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const splitRow = (line) => line.split(/[,\t;]/).map((c) => c.trim());

  // Detect a header row.
  const firstCols = splitRow(lines[0]).map((c) => c.toLowerCase());
  const looksLikeHeader = firstCols.some((c) =>
    /name|mobile|phone|seat|party/.test(c)
  );

  let nameIdx = 0;
  let mobileIdx = 1;
  let seatsIdx = 2;
  let dataLines = lines;

  if (looksLikeHeader) {
    nameIdx = firstCols.findIndex((c) => /name/.test(c));
    mobileIdx = firstCols.findIndex((c) => /mobile|phone/.test(c));
    seatsIdx = firstCols.findIndex((c) => /seat|party|member/.test(c));
    if (nameIdx === -1) nameIdx = 0;
    if (mobileIdx === -1) mobileIdx = 1;
    dataLines = lines.slice(1);
  }

  return dataLines.map((line) => {
    const cols = splitRow(line);
    return {
      full_name: cols[nameIdx] || '',
      mobile: cols[mobileIdx] || '',
      seats: seatsIdx !== -1 ? cols[seatsIdx] : 1,
    };
  });
}

app.post('/api/admin/import', requireAdmin, upload.single('file'), (req, res) => {
  let text = '';
  if (req.file) text = req.file.buffer.toString('utf8');
  else if (req.body && req.body.text) text = String(req.body.text);

  if (!text.trim()) {
    return res.status(400).json({ error: 'No guest data provided.' });
  }

  const rows = parseGuestText(text);
  const valid = rows.filter((r) => r.full_name && r.mobile);
  if (valid.length === 0) {
    return res.status(400).json({
      error: 'Could not find any valid rows. Expected columns: name, mobile, seats.',
    });
  }
  const imported = store.bulkUpsert(valid);
  res.json({ imported, skipped: rows.length - valid.length });
});

app.post('/api/admin/guests/:id/reset', requireAdmin, (req, res) => {
  const guest = store.resetGuest(Number(req.params.id));
  if (!guest) return res.status(404).json({ error: 'Guest not found.' });
  res.json({ guest });
});

app.delete('/api/admin/guests/:id', requireAdmin, (req, res) => {
  const ok = store.deleteGuest(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Guest not found.' });
  res.json({ ok: true });
});

// QR code PNG that encodes the public check-in URL.
app.get('/api/admin/qr', requireAdmin, async (req, res) => {
  const base =
    PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const target = base.replace(/\/+$/, '') + '/';
  try {
    const png = await QRCode.toBuffer(target, {
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code.' });
  }
});

// Expose the check-in URL as text so the dashboard can show/print it.
app.get('/api/admin/qr-target', requireAdmin, (req, res) => {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ url: base.replace(/\/+$/, '') + '/' });
});

// --- Page routes ----------------------------------------------------------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n🎬  QNB Movie Night check-in running on http://localhost:${PORT}`);
  console.log(`    Guest check-in:  http://localhost:${PORT}/`);
  console.log(`    Admin dashboard: http://localhost:${PORT}/admin\n`);
});
