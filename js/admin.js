/* QNB Movie Night — organizer dashboard (admin.html)
   PIN gate -> organizer_dashboard(pin): live counts + auto-promoted guests who
   still need to confirm, each with a one-tap "Notify on WhatsApp" link.
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var CONFIRM_URL = "https://alemadi.github.io/qnb-movie-night/confirm.html";
  var PIN_KEY = "qnb_pin_v1";
  var pin = "";
  var timer = null;

  function $(id) { return document.getElementById(id); }
  function showView(name) {
    ["pin", "dash"].forEach(function (v) { var el = $("view-" + v); if (el) el.classList.toggle("hidden", v !== name); });
    window.scrollTo(0, 0);
  }
  function pinMsg(t, k) { var m = $("pinMsg"); if (!m) return; if (!t) { m.className = "msg"; m.textContent = ""; return; } m.className = "msg show " + (k || "error"); m.textContent = t; }

  // ---- PIN gate ----
  function renderDots() { var d = $("pinDots").children; for (var i = 0; i < d.length; i++) d[i].classList.toggle("is-on", i < pin.length); }
  function onKey(e) {
    var b = e.target.closest("[data-key]"); if (!b) return;
    var k = b.getAttribute("data-key");
    if (k === "clear") pin = ""; else if (k === "back") pin = pin.slice(0, -1);
    else if (/^[0-9]$/.test(k) && pin.length < 4) pin += k;
    renderDots(); pinMsg("");
    if (pin.length === 4) load(true);
  }

  function notifyLink(g) {
    var msg = "🎬 Good news! A seat just opened for QNB Movie Night — Toy Story 5, today 4:00 PM (Novo Cinemas, Doha Oasis). Please confirm now: " + CONFIRM_URL;
    return "https://wa.me/" + encodeURIComponent(g.wa_phone || "") + "?text=" + encodeURIComponent(msg);
  }

  function render(d) {
    $("sCheckedIn").innerHTML = d.checked_in + ' <small>/ ' + d.checked_in_heads + " seats</small>";
    $("sConfirmed").innerHTML = d.confirmed + ' <small>/ ' + d.confirmed_heads + " seats</small>";
    $("sYes").textContent = d.attending_yes;
    $("sDeclined").textContent = d.declined;
    var list = d.promoted_pending || [];
    $("promoCount").textContent = list.length ? "(" + list.length + ")" : "";
    var host = $("promoList");
    host.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div"); e.className = "empty-note";
      e.textContent = "No promotions waiting — everyone promoted has been notified 🎉";
      host.appendChild(e);
    } else {
      list.forEach(function (g) {
        var row = document.createElement("div"); row.className = "promo-row";
        var who = document.createElement("div"); who.className = "who";
        who.innerHTML = "<b></b><small></small>";
        who.querySelector("b").textContent = g.name || "Guest";
        who.querySelector("small").textContent = "+" + (g.wa_phone || "—") + " · " + (g.seats || 1) + " seat(s)";
        var a = document.createElement("a"); a.className = "notify"; a.textContent = "Notify";
        a.href = notifyLink(g); a.target = "_blank"; a.rel = "noopener";
        row.appendChild(who); row.appendChild(a);
        host.appendChild(row);
      });
    }
    $("lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
  }

  async function load(fromPin) {
    if (!sb) { pinMsg("Service unavailable.", "error"); return; }
    if (fromPin) pinMsg("Checking…", "info");
    try {
      var res = await sb.rpc("organizer_dashboard", { p_pin: pin });
      if (res.error) throw res.error;
      var d = res.data;
      if (!d || !d.authorized) {
        pin = ""; renderDots(); pinMsg("Wrong PIN. Try again.", "error");
        try { sessionStorage.removeItem(PIN_KEY); } catch (_) {}
        return;
      }
      try { sessionStorage.setItem(PIN_KEY, pin); } catch (_) {}
      pinMsg(""); showView("dash"); render(d);
      if (!timer) timer = setInterval(load, 30000);
    } catch (e) {
      console.error(e);
      if (fromPin) { pin = ""; renderDots(); pinMsg("No connection — try again.", "error"); }
    }
  }

  function lock() {
    pin = ""; renderDots();
    try { sessionStorage.removeItem(PIN_KEY); } catch (_) {}
    if (timer) { clearInterval(timer); timer = null; }
    showView("pin");
  }

  function onClick(e) {
    var act = e.target.closest("[data-action]"); if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "refresh") load(false);
    else if (a === "lock") lock();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var kp = $("keypad"); if (kp) kp.addEventListener("click", onKey);
    document.body.addEventListener("click", onClick);
    renderDots();
    try { var saved = sessionStorage.getItem(PIN_KEY); if (saved) { pin = saved; load(true); } } catch (_) {}
  });
})();
