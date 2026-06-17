// Guest check-in flow: lookup -> show details -> confirm.
(function () {
  const lookupCard = document.getElementById('lookupCard');
  const detailCard = document.getElementById('detailCard');
  const lookupForm = document.getElementById('lookupForm');
  const lookupBtn = document.getElementById('lookupBtn');
  const mobileInput = document.getElementById('mobile');
  const lookupMsg = document.getElementById('lookupMsg');
  const detailMsg = document.getElementById('detailMsg');
  const confirmBtn = document.getElementById('confirmBtn');
  const backBtn = document.getElementById('backBtn');
  const alreadyBanner = document.getElementById('alreadyBanner');

  const gName = document.getElementById('gName');
  const gMobile = document.getElementById('gMobile');
  const gSeats = document.getElementById('gSeats');
  const gStatus = document.getElementById('gStatus');
  const gTimeRow = document.getElementById('gTimeRow');
  const gTime = document.getElementById('gTime');

  let currentMobile = '';

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg show ' + type;
  }
  function hideMsg(el) {
    el.className = 'msg';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    // SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function renderGuest(guest) {
    gName.textContent = guest.full_name;
    gMobile.textContent = '📱 ' + guest.mobile;
    gSeats.textContent = '🎟️ ' + guest.seats + (guest.seats === 1 ? ' seat' : ' seats') + ' reserved';

    const checked = guest.status === 'checked_in';
    gStatus.textContent = checked ? 'Checked In' : 'Pending';
    gStatus.className = 'status-pill ' + (checked ? 'checked_in' : 'pending');

    if (checked && guest.checked_in_at) {
      gTime.textContent = fmtTime(guest.checked_in_at);
      gTimeRow.classList.remove('hidden');
    } else {
      gTimeRow.classList.add('hidden');
    }

    if (checked) {
      alreadyBanner.classList.remove('hidden');
      confirmBtn.classList.add('hidden');
    } else {
      alreadyBanner.classList.add('hidden');
      confirmBtn.classList.remove('hidden');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Check-In';
    }
  }

  function goToDetail(guest) {
    renderGuest(guest);
    lookupCard.classList.add('hidden');
    detailCard.classList.remove('hidden');
    hideMsg(detailMsg);
    window.scrollTo(0, 0);
  }

  function goToLookup() {
    detailCard.classList.add('hidden');
    lookupCard.classList.remove('hidden');
    hideMsg(lookupMsg);
    mobileInput.focus();
  }

  lookupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg(lookupMsg);
    currentMobile = mobileInput.value.trim();
    if (!currentMobile) return;

    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Searching…';
    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: currentMobile }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMsg(lookupMsg, data.error || 'Something went wrong.', 'error');
        return;
      }
      goToDetail(data.guest);
    } catch (err) {
      showMsg(lookupMsg, 'Network error. Please try again.', 'error');
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Find my booking';
    }
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirming…';
    hideMsg(detailMsg);
    try {
      const res = await fetch('/api/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: currentMobile }),
      });
      const data = await res.json();
      if (!res.ok) {
        showMsg(detailMsg, data.error || 'Something went wrong.', 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm Check-In';
        return;
      }
      renderGuest(data.guest);
      if (data.alreadyCheckedIn) {
        showMsg(detailMsg, 'You were already checked in earlier. Enjoy the movie! 🍿', 'info');
      } else {
        showMsg(detailMsg, 'Check-in confirmed. Enjoy the movie! 🍿', 'success');
      }
    } catch (err) {
      showMsg(detailMsg, 'Network error. Please try again.', 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm Check-In';
    }
  });

  backBtn.addEventListener('click', () => {
    mobileInput.value = '';
    goToLookup();
  });
})();
