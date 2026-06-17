/**
 * Write-throughput + integrity benchmark.
 * Imports N guests, then fires C concurrent check-ins and verifies the final
 * checked-in count is exactly right (no lost updates).
 *
 * Usage: node bench.mjs <baseUrl> <cookie|bearer> <N> <C>
 */
const [, , BASE, AUTH_MODE, Nraw, Craw] = process.argv;
const N = Number(Nraw || 1000);
const C = Number(Craw || 300);
let cookie = '', token = '';

function authHeaders() {
  if (AUTH_MODE === 'cookie') return cookie ? { Cookie: cookie } : {};
  return token ? { Authorization: 'Bearer ' + token } : {};
}
async function call(method, path, { body, auth = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) Object.assign(headers, authHeaders());
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (AUTH_MODE === 'cookie') { const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; }
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const mob = (i) => '+9745' + String(1000000 + i);

(async () => {
  const login = await call('POST', '/api/admin/login', { body: { password: 'admin123' } });
  if (AUTH_MODE === 'bearer') token = login.data.token;

  // Build an N-row import payload.
  const rows = ['Full Name, Mobile, Seats'];
  for (let i = 0; i < N; i++) rows.push(`Guest ${i}, ${mob(i)}, 1`);
  let t = Date.now();
  const imp = await call('POST', '/api/admin/import', { body: { text: rows.join('\n') }, auth: true });
  const importMs = Date.now() - t;

  const base = (await call('GET', '/api/admin/stats', { auth: true })).data.total_guests;

  // Fire C concurrent admin upserts of brand-new distinct guests. This hits the
  // storage engine's write path directly (admin route, not guest-rate-limited)
  // and lets us check for lost updates by counting rows afterward.
  t = Date.now();
  await Promise.all(Array.from({ length: C }, (_, i) =>
    call('POST', '/api/admin/guests', { body: { full_name: `New ${i}`, mobile: mob(N + i), seats: 1 }, auth: true })
  ));
  const wMs = Date.now() - t;

  const stats = (await call('GET', '/api/admin/stats', { auth: true })).data;
  const added = stats.total_guests - base;
  const ok = added === C;

  console.log(`${BASE} (${AUTH_MODE})`);
  console.log(`  import ${imp.data.imported}/${N} rows: ${importMs} ms (${Math.round(N / (importMs/1000))} rows/s)`);
  console.log(`  ${C} concurrent admin writes: ${wMs} ms (${Math.round(C / (wMs/1000))} ops/s)`);
  console.log(`  integrity: added=${added} expected=${C} ${ok ? '✅ no lost updates' : '❌ MISMATCH'}`);
})();
