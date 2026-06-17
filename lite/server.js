/**
 * QNB Movie Night — QR check-in, "Lite / Edge" edition.
 *
 * A single-file HTTP server built on Node's built-in `http` module with ZERO
 * runtime dependencies (no Express, no native modules). Admin auth is a
 * stateless HMAC bearer token, so the server keeps no session state and can be
 * replicated freely or run on serverless/edge platforms.
 *
 * Routes mirror the SQLite edition so the two are functionally comparable:
 *   GET  /                          guest check-in page
 *   POST /api/lookup                find a guest by mobile
 *   POST /api/checkin               confirm check-in (idempotent)
 *   POST /api/admin/login           -> { token }
 *   GET  /api/admin/stats           dashboard totals          (Bearer)
 *   GET  /api/admin/guests?q=       list / search guests      (Bearer)
 *   POST /api/admin/guests          add one guest             (Bearer)
 *   POST /api/admin/import          bulk import pasted/CSV text(Bearer)
 *   POST /api/admin/guests/:id/reset undo a check-in          (Bearer)
 *   DELETE /api/admin/guests/:id    delete a guest            (Bearer)
 *   GET  /api/admin/qr-target       check-in URL for the QR   (Bearer)
 *   GET  /health
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const auth = require('./auth');

const PORT = process.env.PORT || 4000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Tiny in-memory rate limiter (per IP) ---------------------------------
// NOTE: this is per-instance. Behind multiple instances each enforces its own
// budget — fine as a brute-force speed bump, documented in the README.
function makeLimiter(windowMs, max) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now > rec.reset) {
      hits.set(ip, { count: 1, reset: now + windowMs });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  };
}
const guestLimiter = makeLimiter(60 * 1000, 20);
const loginLimiter = makeLimiter(5 * 60 * 1000, 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const isJson = !(typeof body === 'string' || Buffer.isBuffer(body));
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : headers['Content-Type'] || 'text/plain',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireAdmin(req, res) {
  if (auth.verifyToken(bearer(req))) return true;
  send(res, 401, { error: 'Unauthorized. Please log in as admin.' });
  return false;
}

// Only expose the fields a guest may see about themselves.
function publicGuestView(g) {
  return {
    full_name: g.full_name,
    mobile: g.mobile,
    seats: g.seats,
    status: g.status,
    checked_in_at: g.checked_in_at,
  };
}

// CSV / pasted-text parser — same rules as the SQLite edition's importer.
function parseGuestText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const splitRow = (line) => line.split(/[,\t;]/).map((c) => c.trim());
  const firstCols = splitRow(lines[0]).map((c) => c.toLowerCase());
  const looksLikeHeader = firstCols.some((c) => /name|mobile|phone|seat|party/.test(c));

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

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // Prevent path traversal outside the public dir.
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback for /admin
      if (pathname === '/admin') {
        return fs.readFile(path.join(PUBLIC_DIR, 'admin.html'), (e2, b2) =>
          e2 ? send(res, 404, 'Not found') : send(res, 200, b2, { 'Content-Type': MIME['.html'] })
        );
      }
      return send(res, 404, 'Not found');
    }
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const ip = clientIp(req);

  try {
    // --- Guest API --------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/lookup') {
      if (!guestLimiter(ip)) return send(res, 429, { error: 'Too many requests. Please wait a moment.' });
      const { mobile } = await readJson(req);
      if (!mobile || !String(mobile).trim()) return send(res, 400, { error: 'Please enter your mobile number.' });
      const guest = store.findByMobile(mobile);
      if (!guest) {
        return send(res, 404, {
          error: 'No reservation found for that mobile number. Please check the number or see a staff member.',
        });
      }
      return send(res, 200, { guest: publicGuestView(guest) });
    }

    if (req.method === 'POST' && pathname === '/api/checkin') {
      if (!guestLimiter(ip)) return send(res, 429, { error: 'Too many requests. Please wait a moment.' });
      const { mobile } = await readJson(req);
      if (!mobile || !String(mobile).trim()) return send(res, 400, { error: 'Please enter your mobile number.' });
      const result = store.checkInByMobile(mobile);
      if (!result.ok) return send(res, 404, { error: 'No reservation found for that mobile number.' });
      return send(res, 200, {
        alreadyCheckedIn: result.alreadyCheckedIn,
        guest: publicGuestView(result.guest),
      });
    }

    // --- Admin auth -------------------------------------------------------
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      if (!loginLimiter(ip)) return send(res, 429, { error: 'Too many attempts. Please wait and try again.' });
      const { password } = await readJson(req);
      if (!password || !auth.checkAdminPassword(String(password))) {
        return send(res, 401, { error: 'Incorrect password.' });
      }
      return send(res, 200, { token: auth.issueToken() });
    }

    if (req.method === 'GET' && pathname === '/api/admin/me') {
      return send(res, 200, { isAdmin: auth.verifyToken(bearer(req)) });
    }

    // --- Admin API (all require a valid bearer token) ---------------------
    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, store.getStats());
    }

    if (pathname === '/api/admin/guests' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return send(res, 200, { guests: store.listGuests(url.searchParams.get('q') || '') });
    }

    if (pathname === '/api/admin/guests' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const { full_name, mobile, seats } = await readJson(req);
      if (!full_name || !mobile) return send(res, 400, { error: 'Full name and mobile number are required.' });
      return send(res, 200, { guest: store.upsertGuest({ full_name, mobile, seats }) });
    }

    if (pathname === '/api/admin/import' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const { text } = await readJson(req);
      if (!text || !String(text).trim()) return send(res, 400, { error: 'No guest data provided.' });
      const rows = parseGuestText(String(text));
      const valid = rows.filter((r) => r.full_name && r.mobile);
      if (valid.length === 0) {
        return send(res, 400, { error: 'Could not find any valid rows. Expected columns: name, mobile, seats.' });
      }
      const imported = store.bulkUpsert(valid);
      return send(res, 200, { imported, skipped: rows.length - valid.length });
    }

    let m = pathname.match(/^\/api\/admin\/guests\/(\d+)\/reset$/);
    if (m && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const guest = store.resetGuest(Number(m[1]));
      if (!guest) return send(res, 404, { error: 'Guest not found.' });
      return send(res, 200, { guest });
    }

    m = pathname.match(/^\/api\/admin\/guests\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      if (!store.deleteGuest(Number(m[1]))) return send(res, 404, { error: 'Guest not found.' });
      return send(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/qr-target' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const base = PUBLIC_URL || `http://${req.headers.host}`;
      return send(res, 200, { url: base.replace(/\/+$/, '') + '/' });
    }

    if (pathname === '/health') return send(res, 200, { ok: true });

    // --- Static frontend --------------------------------------------------
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (String(err.message).includes('payload too large')) {
      return send(res, 413, { error: 'Payload too large.' });
    }
    return send(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`\n🎬  QNB Movie Night (Lite/Edge) running on http://localhost:${PORT}`);
  console.log(`    Guest check-in:  http://localhost:${PORT}/`);
  console.log(`    Admin dashboard: http://localhost:${PORT}/admin\n`);
});

module.exports = server;
