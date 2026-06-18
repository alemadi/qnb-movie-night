/* QNB Movie Night — guest verify + ticket
   verify_guest(p_mobile) -> { found, status, name, guest_count, hall, ticket_token, checked_in }
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var CACHE_KEY = "qnb_ticket_v1";

  // ---- tiny view helpers -------------------------------------------------
  var views = ["verify", "loading", "notfound", "waitlist", "ticket"];
  function show(name) {
    views.forEach(function (v) {
      var el = document.getElementById("view-" + v);
      if (el) el.classList.toggle("hidden", v !== name);
    });
    window.scrollTo(0, 0);
  }
  function msg(text, kind) {
    var m = document.getElementById("verifyMsg");
    if (!m) return;
    if (!text) { m.className = "msg"; m.textContent = ""; return; }
    m.className = "msg show " + (kind || "error");
    m.textContent = text;
  }
  function $(id) { return document.getElementById(id); }

  // ---- derived display bits ---------------------------------------------
  function refFromToken(token) {
    return "TS5-" + String(token).replace(/-/g, "").slice(0, 6).toUpperCase();
  }
  function barcodeFromToken(token) {
    var hex = String(token).replace(/-/g, "").toUpperCase();
    return hex.slice(0, 4) + " " + hex.slice(4, 10) + " " + hex.slice(10, 16);
  }

  // ---- ticket rendering --------------------------------------------------
  function renderTicket(g, opts) {
    opts = opts || {};
    $("tName").textContent = g.name || "Guest";
    $("tHall").textContent = g.hall || "—";
    $("tGuests").textContent = g.guest_count != null ? String(g.guest_count) : "—";
    $("tRef").textContent = refFromToken(g.ticket_token);
    $("tBarcodeRef").textContent = barcodeFromToken(g.ticket_token);
    $("ticketAdmitted").classList.toggle("hidden", !g.checked_in);
    $("offlineBanner").classList.toggle("hidden", !opts.offline);

    var qrEl = $("qrCanvas");
    if (window.QRCode && qrEl) {
      qrEl.innerHTML = "";
      // Encode the RAW token string — not a URL, not the mobile.
      new window.QRCode(qrEl, {
        text: String(g.ticket_token),
        width: 200, height: 200,
        colorDark: "#0b0e14", colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.M
      });
    }
    show("ticket");
  }

  function cacheTicket(g) {
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(g)); } catch (e) {}
  }
  function readCache() {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null"); } catch (e) { return null; }
  }

  // ---- routing a verify_guest result ------------------------------------
  function route(row) {
    if (!row || !row.found) { show("notfound"); return; }
    if (row.status === "confirmed" && row.ticket_token) {
      cacheTicket(row);
      renderTicket(row, { offline: false });
    } else {
      // waitlist (no ticket)
      var wl = $("wlName");
      if (wl && row.name) wl.textContent = (row.name.split(" ")[0] || "You") + ", you're on the waitlist";
      show("waitlist");
    }
  }

  // ---- submit ------------------------------------------------------------
  function digits(s) { return String(s || "").replace(/\D/g, ""); }

  async function onSubmit(e) {
    e.preventDefault();
    msg("");
    var raw = $("mobile").value;
    var local = digits(raw);
    if (local.length < 7) { msg("Please enter your full mobile number."); return; }
    // Hand the +974 + local number to the RPC; it normalises to the last 8 digits.
    var full = "+974" + local;

    if (!sb) { msg("Service unavailable. Please see a staff member.", "error"); return; }

    show("loading");
    try {
      var res = await sb.rpc("verify_guest", { p_mobile: full });
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      route(row);
    } catch (err) {
      console.error(err);
      // Venue resilience: if we already loaded a ticket this session, fall back to it.
      var cached = readCache();
      if (cached) { renderTicket(cached, { offline: true }); }
      else { show("verify"); msg("No connection. Check your signal and try again.", "error"); }
    }
  }

  // ---- mobile input: light grouping -------------------------------------
  function formatMobile(e) {
    var d = digits(e.target.value).slice(0, 8);
    e.target.value = d.length > 4 ? d.slice(0, 4) + " " + d.slice(4) : d;
  }

  // ---- actions (reset / screenshot) -------------------------------------
  function onClick(e) {
    var act = e.target.closest("[data-action]");
    if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "reset") {
      try { sessionStorage.removeItem(CACHE_KEY); } catch (_) {}
      var inp = $("mobile"); if (inp) inp.value = "";
      msg(""); show("verify");
    } else if (a === "screenshot") {
      msg("");
      var b = $("offlineBanner");
      // brief visual cue; the actual capture is the phone's screenshot gesture
      act.textContent = "📸 Take your screenshot now";
      setTimeout(function () { act.textContent = "📸 Save by screenshot"; }, 2200);
    }
  }

  // ---- preview harness (screenshots only; ?preview=STATE) ----------------
  function preview(state) {
    var mock = {
      found: true, status: "confirmed",
      name: "Fatima Al-Naimi", guest_count: 3, hall: "Hall 4",
      ticket_token: "9214885b-0d26-474f-a7c9-6c0c4f939d3a", checked_in: false
    };
    if (state === "verify") show("verify");
    else if (state === "loading") show("loading");
    else if (state === "notfound") route({ found: false });
    else if (state === "waitlist") route({ found: true, status: "waitlist", name: "Omar Khan", checked_in: false });
    else if (state === "ticket") renderTicket(mock, { offline: false });
    else if (state === "checkedin") renderTicket(Object.assign({}, mock, { checked_in: true }), { offline: false });
    else if (state === "offline") renderTicket(mock, { offline: true });
  }

  // ---- boot --------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", function () {
    var form = $("verifyForm");
    if (form) form.addEventListener("submit", onSubmit);
    var inp = $("mobile");
    if (inp) inp.addEventListener("input", formatMobile);
    document.body.addEventListener("click", onClick);

    var p = new URLSearchParams(location.search).get("preview");
    if (p) { preview(p); return; }

    // Resume a cached ticket if the page reloads mid-event (flaky Wi-Fi).
    var cached = readCache();
    if (cached && cached.ticket_token) {
      renderTicket(cached, { offline: !navigator.onLine });
    }
  });
})();
