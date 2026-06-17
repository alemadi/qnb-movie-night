/**
 * Stateless admin auth for the "Lite / Edge" edition.
 *
 * Unlike the SQLite edition (which keeps server-side sessions in memory and a
 * cookie), this edition issues a self-contained, HMAC-signed bearer token. The
 * server keeps NO session state, so any number of instances behind a load
 * balancer — or cold-starting serverless functions — can verify a token
 * without sharing memory or a session store. That is the whole point of this
 * edition.
 *
 * Token format:  base64url(payload).base64url(hmacSHA256(payload, secret))
 *   payload = { exp: <epoch ms> }
 *
 * Password handling uses Node's built-in scrypt (no bcryptjs dependency). The
 * admin secret is supplied as either a scrypt hash ("salt:hash") or a plain
 * password that is hashed once at startup.
 */
const crypto = require('crypto');

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'change-me-in-production-' + crypto.randomBytes(8).toString('hex');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours, same as the SQLite edition

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// --- Password hashing (scrypt) --------------------------------------------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(plain, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Admin secret: ADMIN_PASSWORD_HASH ("salt:hash") wins; else hash ADMIN_PASSWORD;
// else fall back to "admin123" for local dev only.
const ADMIN_PASSWORD_HASH =
  process.env.ADMIN_PASSWORD_HASH ||
  hashPassword(process.env.ADMIN_PASSWORD || 'admin123');

// --- Token issue / verify -------------------------------------------------
function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
}

function issueToken() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  // Constant-time compare of the signatures.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  checkAdminPassword: (plain) => verifyPassword(plain, ADMIN_PASSWORD_HASH),
};
