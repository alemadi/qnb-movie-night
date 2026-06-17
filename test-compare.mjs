/**
 * Head-to-head functional test: runs the SAME check-in suite against both
 * editions and prints a pass/fail table. Auth differs (Solution A = session
 * cookie, Solution B = bearer token) so the harness adapts per target.
 *
 * Usage: node test-compare.mjs <baseUrl> <cookie|bearer>
 */
const [, , BASE, AUTH_MODE] = process.argv;
if (!BASE || !AUTH_MODE) {
  console.error('usage: node test-compare.mjs <baseUrl> <cookie|bearer>');
  process.exit(2);
}

let cookie = '';
let token = '';
let pass = 0;
let fail = 0;

function authHeaders() {
  if (AUTH_MODE === 'cookie') return cookie ? { Cookie: cookie } : {};
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function call(method, path, { body, auth = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) Object.assign(headers, authHeaders());
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (AUTH_MODE === 'cookie') {
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
  }
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`); }
}

const CSV = `Full Name, Mobile, Seats
Sara Ahmed, +97455123456, 2
Khalid Al-Thani, +97466778899, 4
Maryam Hassan, +97433445566, 1`;

(async () => {
  console.log(`\n=== ${BASE}  (auth: ${AUTH_MODE}) ===`);

  // 0. Admin endpoints must reject anonymous callers.
  const anon = await call('GET', '/api/admin/stats');
  check('admin stats blocked without auth', anon.status === 401, `got ${anon.status}`);

  // 1. Login.
  const login = await call('POST', '/api/admin/login', { body: { password: 'admin123' } });
  if (AUTH_MODE === 'bearer') token = login.data.token;
  check('admin login succeeds', login.status === 200, `got ${login.status}`);

  // 2. Import a guest list.
  const imp = await call('POST', '/api/admin/import', { body: { text: CSV }, auth: true });
  check('import 3 guests', imp.status === 200 && imp.data.imported === 3, JSON.stringify(imp.data));

  // 3. Stats reflect the import.
  let stats = (await call('GET', '/api/admin/stats', { auth: true })).data;
  check('stats: 3 guests / 7 seats', stats.total_guests === 3 && stats.total_seats === 7, JSON.stringify(stats));

  // 4. Guest lookup (normalized: type the number messily).
  const look = await call('POST', '/api/lookup', { body: { mobile: '+974 5512-3456' } });
  check('lookup finds Sara via messy number', look.status === 200 && look.data.guest.full_name === 'Sara Ahmed', JSON.stringify(look.data));
  check('lookup hides private fields (no id/created_at)', look.data.guest && look.data.guest.id === undefined && look.data.guest.created_at === undefined);

  // 5. Lookup unknown number 404s.
  const miss = await call('POST', '/api/lookup', { body: { mobile: '+9740000' } });
  check('lookup unknown number 404s', miss.status === 404, `got ${miss.status}`);

  // 6. First check-in.
  const ci1 = await call('POST', '/api/checkin', { body: { mobile: '+97455123456' } });
  check('first check-in succeeds', ci1.status === 200 && ci1.data.alreadyCheckedIn === false, JSON.stringify(ci1.data));

  // 7. Duplicate check-in is idempotent.
  const ci2 = await call('POST', '/api/checkin', { body: { mobile: '+97455123456' } });
  check('duplicate check-in is idempotent', ci2.status === 200 && ci2.data.alreadyCheckedIn === true, JSON.stringify(ci2.data));

  // 8. Stats now show 1 checked in (2 seats).
  stats = (await call('GET', '/api/admin/stats', { auth: true })).data;
  check('stats: 1 checked in / 2 seats', stats.checked_in_guests === 1 && stats.checked_in_seats === 2, JSON.stringify(stats));

  // 9. Search.
  const search = await call('GET', '/api/admin/guests?q=Khalid', { auth: true });
  check('search "Khalid" returns 1', search.data.guests && search.data.guests.length === 1, JSON.stringify(search.data.guests && search.data.guests.length));

  // 10. Re-import updates instead of duplicating (same mobile, new seats).
  await call('POST', '/api/admin/import', { body: { text: 'Sara Ahmed, +97455123456, 5' }, auth: true });
  stats = (await call('GET', '/api/admin/stats', { auth: true })).data;
  check('re-import updates, no duplicate (still 3 guests)', stats.total_guests === 3, JSON.stringify(stats));

  // 11. Reset a check-in.
  const all = (await call('GET', '/api/admin/guests', { auth: true })).data.guests;
  const sara = all.find((g) => g.full_name === 'Sara Ahmed');
  const reset = await call('POST', `/api/admin/guests/${sara.id}/reset`, { auth: true });
  check('reset check-in', reset.status === 200 && reset.data.guest.status === 'pending', JSON.stringify(reset.data));

  // 12. Delete a guest.
  const del = await call('DELETE', `/api/admin/guests/${sara.id}`, { auth: true });
  stats = (await call('GET', '/api/admin/stats', { auth: true })).data;
  check('delete guest (2 remain)', del.status === 200 && stats.total_guests === 2, JSON.stringify(stats));

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
