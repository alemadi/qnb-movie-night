/* QNB Movie Night — organizer scanner
   check_in(p_token, p_pin) -> { valid, authorized, already_checked_in, name, hall, guest_count, checked_in_at }
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var PIN_KEY = "qnb_pin_v1";              // sessionStorage only — never persisted
  var ZERO_UUID = "00000000-0000-0000-0000-000000000000";

  var pin = "";
  var admitted = 0;
  var scanner = null;       // Html5Qrcode instance
  var busy = false;         // a check_in is in flight / result showing
  var lastToken = null;     // for offline "Retry"

  function $(id) { return document.getElementById(id); }
  function showView(name) {
    ["pin", "scan", "result"].forEach(function (v) {
      var el = $("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    window.scrollTo(0, 0);
  }
  function pinMsg(text, kind) {
    var m = $("pinMsg");
    if (!m) return;
    if (!text) { m.className = "msg"; m.textContent = ""; return; }
    m.className = "msg show " + (kind || "error");
    m.textContent = text;
  }

  // ---- PIN gate ----------------------------------------------------------
  function renderDots() {
    var dots = $("pinDots").children;
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < pin.length);
  }
  function onKey(e) {
    var btn = e.target.closest("[data-key]");
    if (!btn) return;
    var k = btn.getAttribute("data-key");
    if (k === "clear") pin = "";
    else if (k === "back") pin = pin.slice(0, -1);
    else if (/^[0-9]$/.test(k) && pin.length < 4) pin += k;
    renderDots();
    pinMsg("");
    if (pin.length === 4) validatePin();
  }

  async function validatePin() {
    if (!sb) { pinMsg("Service unavailable.", "error"); return; }
    pinMsg("Checking…", "info");
    try {
      // Probe the PIN with a harmless non-existent token: authorized reflects PIN only.
      var res = await sb.rpc("check_in", { p_token: ZERO_UUID, p_pin: pin });
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (row && row.authorized) {
        try { sessionStorage.setItem(PIN_KEY, pin); } catch (_) {}
        pinMsg("");
        startScanning();
      } else {
        pin = ""; renderDots();
        pinMsg("Wrong PIN. Try again.", "error");
      }
    } catch (err) {
      console.error(err);
      pin = ""; renderDots();
      pinMsg("No connection — check Wi-Fi and re-enter the PIN.", "error");
    }
  }

  function lock() {
    pin = ""; renderDots();
    try { sessionStorage.removeItem(PIN_KEY); } catch (_) {}
    stopScanning();
    showView("pin");
  }

  // ---- Scanning ----------------------------------------------------------
  function startScanning() {
    showView("scan");
    if (!window.Html5Qrcode) return; // preview / no camera lib
    if (!scanner) scanner = new window.Html5Qrcode("reader", { verbose: false });
    busy = false;
    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      onDecoded,
      function () { /* per-frame decode failures are normal; ignore */ }
    ).catch(function (err) {
      console.error("camera start failed", err);
      pinMsg("");
      showView("scan");
      $("reader").innerHTML =
        '<div class="result invalid" style="padding:28px"><div class="ricon">📷</div>' +
        '<h2>Camera unavailable</h2><p class="rmeta">Allow camera access in your browser and reload. ' +
        'On iOS use Safari; on Android use Chrome.</p></div>';
    });
  }
  function stopScanning() {
    if (scanner && scanner.isScanning) { scanner.stop().catch(function () {}); }
  }
  function pauseScanning() {
    try { if (scanner && scanner.isScanning) scanner.pause(true); } catch (_) {}
  }
  function resumeScanning() {
    busy = false;
    showView("scan");
    try { if (scanner && scanner.isScanning) scanner.resume(); } catch (_) {}
  }

  function onDecoded(text) {
    if (busy) return;
    busy = true;
    pauseScanning();
    doCheckIn(String(text || "").trim());
  }

  // ---- check_in ----------------------------------------------------------
  async function doCheckIn(token) {
    lastToken = token;
    var thePin = pin || (function () { try { return sessionStorage.getItem(PIN_KEY) || ""; } catch (_) { return ""; } })();
    if (!sb) { return; }
    try {
      var res = await sb.rpc("check_in", { p_token: token, p_pin: thePin });
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      handleResult(row);
    } catch (err) {
      console.error(err);
      // Never silently admit/reject on a network error — show retry.
      renderResult("offline");
    }
  }

  function handleResult(row) {
    if (!row) { renderResult("invalid"); return; }
    if (!row.authorized) {           // PIN changed/revoked mid-session
      stopScanning();
      pin = ""; renderDots();
      try { sessionStorage.removeItem(PIN_KEY); } catch (_) {}
      showView("pin");
      pinMsg("Session expired — re-enter the PIN.", "error");
      return;
    }
    if (!row.valid) { renderResult("invalid"); return; }
    if (row.already_checked_in) { renderResult("already", row); return; }
    admitted += 1;
    renderResult("admit", row);
  }

  // ---- Result rendering --------------------------------------------------
  function fmtWhen(iso) {
    if (!iso) return "Checked in earlier";
    try {
      var d = new Date(iso);
      return "Checked in " + d.toLocaleString(undefined,
        { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (_) { return "Checked in earlier"; }
  }
  function renderResult(kind, row) {
    var tpl = $("tpl-" + (kind === "admit" ? "admit" : kind === "already" ? "already" : kind === "offline" ? "offline" : "invalid"));
    var node = tpl.content.cloneNode(true);
    if (row) {
      var set = function (f, val) { var el = node.querySelector('[data-f="' + f + '"]'); if (el) el.textContent = val; };
      set("name", row.name || "Guest");
      set("hall", row.hall || "—");
      set("guests", row.guest_count != null ? row.guest_count : "—");
      if (kind === "already") set("when", fmtWhen(row.checked_in_at));
    }
    var body = $("resultBody");
    body.innerHTML = "";
    body.appendChild(node);
    $("nextBtn").classList.toggle("hidden", kind === "offline");
    $("scanCount").textContent = admitted + " admitted";
    showView("result");
  }

  // ---- actions -----------------------------------------------------------
  async function assignHall(hall, btn) {
    var thePin = pin || (function () { try { return sessionStorage.getItem(PIN_KEY) || ""; } catch (_) { return ""; } })();
    if (!sb || !lastToken) return;
    var btns = btn.parentNode.querySelectorAll("[data-hall]");
    btns.forEach(function (b) { b.disabled = true; });
    try {
      var res = await sb.rpc("set_hall", { p_token: lastToken, p_pin: thePin, p_hall: hall });
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      var prompt = $("hallPrompt");
      if (row && row.ok) {
        btns.forEach(function (b) {
          b.classList.toggle("selected", b.getAttribute("data-hall") === hall);
          b.classList.toggle("dim", b.getAttribute("data-hall") !== hall);
          b.disabled = false;
        });
        if (prompt) { prompt.textContent = "✓ Sent to " + hall; prompt.classList.add("done"); }
      } else {
        if (prompt) prompt.textContent = "Couldn't save — tap again";
        btns.forEach(function (b) { b.disabled = false; });
      }
    } catch (err) {
      console.error(err);
      var p = $("hallPrompt");
      if (p) p.textContent = "No connection — tap again";
      btns.forEach(function (b) { b.disabled = false; });
    }
  }

  function onClick(e) {
    var hallBtn = e.target.closest("[data-hall]");
    if (hallBtn) { assignHall(hallBtn.getAttribute("data-hall"), hallBtn); return; }
    var act = e.target.closest("[data-action]");
    if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "next") resumeScanning();
    else if (a === "lock") lock();
    else if (a === "retry") {
      if (lastToken) { showView("scan"); busy = true; doCheckIn(lastToken); }
      else resumeScanning();
    }
  }

  // ---- preview harness (?preview=STATE) ----------------------------------
  function preview(state) {
    var row = { valid: true, authorized: true, already_checked_in: false, name: "Fatima Al-Naimi", hall: "Hall 4", guest_count: 3, checked_in_at: "2026-06-20T19:32:00+03:00" };
    if (state === "pin") { showView("pin"); }
    else if (state === "scan") { showView("scan"); $("reader").innerHTML = '<div class="scan-frame"><div class="reticle"></div></div>'; }
    else if (state === "admit") { admitted = 12; renderResult("admit", row); }
    else if (state === "already") { admitted = 12; renderResult("already", row); }
    else if (state === "invalid") { admitted = 12; renderResult("invalid"); }
    else if (state === "offline") { renderResult("offline"); }
    else if (state === "wrongpin") { showView("pin"); pinMsg("Wrong PIN. Try again.", "error"); }
  }

  // ---- boot --------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    var kp = $("keypad"); if (kp) kp.addEventListener("click", onKey);
    document.body.addEventListener("click", onClick);
    renderDots();

    var p = new URLSearchParams(location.search).get("preview");
    if (p) { preview(p); return; }
  });
})();
