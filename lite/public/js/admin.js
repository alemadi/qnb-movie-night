// Admin dashboard (Lite edition): stateless bearer-token auth, stats, guest
// table, import (file read client-side), client-side QR.
(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'qnb_admin_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg show ' + type;
  }
  function hideMsg(el) { el.className = 'msg'; }

  function fmtTime(iso) {
    if (!iso) return '—';
    // The Lite store returns ISO-8601 timestamps already; parse directly.
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Wraps fetch and injects the bearer token. A 401 forces re-login.
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && !path.endsWith('/login')) {
      setToken('');
      showLogin();
    }
    return { res, data };
  }

  // --- Auth ---------------------------------------------------------------
  async function checkAuth() {
    if (!getToken()) return showLogin();
    const { data } = await api('/api/admin/me');
    if (data.isAdmin) enterDashboard();
    else showLogin();
  }

  function showLogin() {
    $('loginView').classList.remove('hidden');
    $('dashView').classList.add('hidden');
    $('password').focus();
  }

  function enterDashboard() {
    $('loginView').classList.add('hidden');
    $('dashView').classList.remove('hidden');
    loadStats();
    loadGuests();
    loadQr();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg($('loginMsg'));
    $('loginBtn').disabled = true;
    const { res, data } = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    $('loginBtn').disabled = false;
    if (!res.ok) { showMsg($('loginMsg'), data.error || 'Login failed.', 'error'); return; }
    setToken(data.token);
    $('password').value = '';
    enterDashboard();
  });

  $('logoutBtn').addEventListener('click', () => {
    // Stateless: logging out just drops the local token. No server call needed.
    setToken('');
    showLogin();
  });

  // --- Tabs ---------------------------------------------------------------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      document.querySelectorAll('section[data-panel]').forEach((s) => {
        s.classList.toggle('hidden', s.dataset.panel !== name);
      });
    });
  });

  // --- Stats --------------------------------------------------------------
  async function loadStats() {
    const { res, data } = await api('/api/admin/stats');
    if (!res.ok) return;
    $('stTotalGuests').textContent = data.total_guests;
    $('stTotalSeats').textContent = data.total_seats;
    $('stChecked').textContent = data.checked_in_guests;
    $('stRemaining').textContent = data.remaining_guests;
  }

  // --- Guests table -------------------------------------------------------
  let searchTimer = null;

  async function loadGuests() {
    const q = $('search').value.trim();
    const { res, data } = await api('/api/admin/guests?q=' + encodeURIComponent(q));
    const body = $('guestsBody');
    if (!res.ok) {
      body.innerHTML = '<tr><td colspan="6" class="muted center">Failed to load.</td></tr>';
      return;
    }
    if (!data.guests.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted center">No guests found.</td></tr>';
      return;
    }
    body.innerHTML = data.guests.map((g) => {
      const checked = g.status === 'checked_in';
      const pill = checked
        ? '<span class="status-pill checked_in">Checked In</span>'
        : '<span class="status-pill pending">Pending</span>';
      const action = checked
        ? `<button class="secondary small" data-reset="${g.id}">Undo</button>`
        : `<button class="small" data-checkin="${g.id}" data-mobile="${escapeHtml(g.mobile)}">Check in</button>`;
      return `<tr>
        <td>${escapeHtml(g.full_name)}</td>
        <td>${escapeHtml(g.mobile)}</td>
        <td>${g.seats}</td>
        <td>${pill}</td>
        <td>${checked ? fmtTime(g.checked_in_at) : '—'}</td>
        <td><div class="row" style="gap:6px">${action}
          <button class="danger small" data-del="${g.id}">Delete</button></div></td>
      </tr>`;
    }).join('');
  }

  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadGuests, 200);
  });
  $('refreshBtn').addEventListener('click', () => { loadStats(); loadGuests(); });

  // Table action buttons (event delegation).
  $('guestsBody').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.checkin) {
      await api('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: t.dataset.mobile }),
      });
    } else if (t.dataset.reset) {
      await api('/api/admin/guests/' + t.dataset.reset + '/reset', { method: 'POST' });
    } else if (t.dataset.del) {
      if (!confirm('Delete this guest?')) return;
      await api('/api/admin/guests/' + t.dataset.del, { method: 'DELETE' });
    }
    loadStats();
    loadGuests();
  });

  // --- Add single guest ---------------------------------------------------
  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg($('addMsg'));
    const { res, data } = await api('/api/admin/guests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: $('aName').value,
        mobile: $('aMobile').value,
        seats: $('aSeats').value,
      }),
    });
    if (!res.ok) { showMsg($('addMsg'), data.error || 'Failed to add.', 'error'); return; }
    showMsg($('addMsg'), `Saved ${data.guest.full_name}.`, 'success');
    $('addForm').reset();
    $('aSeats').value = 1;
    loadStats(); loadGuests();
  });

  // --- Bulk import (file is read in the browser, posted as text) ----------
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  $('importBtn').addEventListener('click', async () => {
    hideMsg($('importMsg'));
    const file = $('csvFile').files[0];
    let text = $('pasteText').value.trim();
    if (!file && !text) {
      showMsg($('importMsg'), 'Choose a file or paste some rows first.', 'error');
      return;
    }
    if (file) text = await readFileText(file);
    const { res, data } = await api('/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) { showMsg($('importMsg'), data.error || 'Import failed.', 'error'); return; }
    showMsg($('importMsg'),
      `Imported ${data.imported} guest(s)${data.skipped ? `, skipped ${data.skipped} invalid row(s)` : ''}.`,
      'success');
    $('csvFile').value = '';
    $('pasteText').value = '';
    loadStats(); loadGuests();
  });

  // --- QR (rendered client-side from the check-in URL) --------------------
  async function loadQr() {
    const { res, data } = await api('/api/admin/qr-target');
    if (!res.ok) return;
    $('qrUrl').textContent = data.url;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(data.url);
      qr.make();
      $('qrImg').innerHTML = qr.createImgTag(6, 8); // cellSize, margin
      const img = $('qrImg').querySelector('img');
      if (img) { img.alt = 'Check-in QR code'; img.style.maxWidth = '320px'; img.style.width = '100%'; }
    } catch (e) {
      $('qrImg').textContent = 'QR library unavailable offline — the check-in URL is shown below.';
    }
  }
  $('printBtn').addEventListener('click', () => window.print());

  // Go.
  checkAuth();
})();
