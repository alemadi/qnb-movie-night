/* QNB Movie Night — organizer dashboard (admin.html)
   PIN gate -> live counts + promoted-but-unconfirmed guests (Notify / Undo),
   plus a manual "Promote from waitlist" panel (organizer chooses who gets a seat).
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var CONFIRM_URL = new URL("confirm.html", location.href).href;
  var PIN_KEY = "qnb_pin_v1";
  var pin = "";
  var timer = null;
  var waitlist = [];    // full waitlist from list_waitlist
  var wlFilter = "";

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
    var msg = "🎬 Good news! A seat just opened for QNB Movie Night — Toy Story 5, today. Please arrive by 4:00 PM (the movie starts at 4:30 PM) at Novo Cinemas, Doha Oasis. Confirm now: " + CONFIRM_URL;
    return "https://wa.me/" + encodeURIComponent(g.wa_phone || "") + "?text=" + encodeURIComponent(msg);
  }

  function row(name, sub) {
    var r = document.createElement("div"); r.className = "promo-row";
    var who = document.createElement("div"); who.className = "who";
    who.innerHTML = "<b></b><small></small>";
    who.querySelector("b").textContent = name || "Guest";
    who.querySelector("small").textContent = sub;
    r.appendChild(who);
    return r;
  }

  // ---- dashboard counts + promoted list ----
  function render(d) {
    $("sCheckedIn").innerHTML = d.checked_in + ' <small>/ ' + d.checked_in_heads + " seats</small>";
    $("sConfirmed").innerHTML = d.confirmed + ' <small>/ ' + d.confirmed_heads + " seats</small>";
    $("sYes").textContent = d.attending_yes;
    $("sDeclined").textContent = d.declined;
    var list = d.promoted_pending || [];
    $("promoCount").textContent = list.length ? "(" + list.length + ")" : "";
    var host = $("promoList"); host.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div"); e.className = "empty-note";
      e.textContent = "No one promoted yet. Promote guests from the waitlist below.";
      host.appendChild(e);
    } else {
      list.forEach(function (g) {
        var r = row(g.name, "+" + (g.wa_phone || "—") + " · " + (g.seats || 1) + " seat(s)");
        var a = document.createElement("a"); a.className = "notify"; a.textContent = "Notify";
        a.href = notifyLink(g); a.target = "_blank"; a.rel = "noopener";
        var undo = document.createElement("button"); undo.className = "undo"; undo.textContent = "Undo";
        undo.setAttribute("data-action", "unpromote"); undo.setAttribute("data-wa", g.wa_phone || "");
        r.appendChild(a); r.appendChild(undo);
        host.appendChild(r);
      });
    }
    $("lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
  }

  // ---- waitlist promote panel ----
  function renderWaitlist() {
    var host = $("waitList"); if (!host) return;
    host.innerHTML = "";
    var q = wlFilter.trim().toLowerCase();
    var rows = waitlist.filter(function (g) {
      if (!q) return true;
      return (g.name || "").toLowerCase().indexOf(q) >= 0 || (g.wa_phone || "").indexOf(q) >= 0;
    });
    if (!rows.length) {
      var e = document.createElement("div"); e.className = "empty-note";
      e.textContent = q ? "No waitlist guest matches that search." : "Waitlist is empty.";
      host.appendChild(e); return;
    }
    rows.slice(0, 60).forEach(function (g) {
      var r = row(g.name, "+" + (g.wa_phone || "—") + " · " + (g.seats || 1) + " seat(s)");
      var btn = document.createElement("button"); btn.className = "promote"; btn.textContent = "Promote";
      btn.setAttribute("data-action", "promote"); btn.setAttribute("data-wa", g.wa_phone || "");
      r.appendChild(btn);
      host.appendChild(r);
    });
    if (rows.length > 60) {
      var more = document.createElement("div"); more.className = "empty-note";
      more.textContent = "Showing 60 of " + rows.length + " — search to narrow.";
      host.appendChild(more);
    }
  }

  async function loadWaitlist() {
    if (!sb) return;
    try {
      var res = await sb.rpc("list_waitlist", { p_pin: pin });
      if (res.error) throw res.error;
      var d = res.data;
      if (!d || !d.authorized) return;
      waitlist = d.waitlist || [];
      var tag = $("availTag");
      if (tag) tag.textContent = (d.available > 0)
        ? (d.available + " seat" + (d.available > 1 ? "s" : "") + " freed by declines")
        : (waitlist.length + " waiting");
      renderWaitlist();
    } catch (e) { console.error(e); }
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
      loadWaitlist();
      if (!timer) timer = setInterval(function () { load(false); }, 30000);
    } catch (e) {
      console.error(e);
      if (fromPin) { pin = ""; renderDots(); pinMsg("No connection — try again.", "error"); }
    }
  }

  async function rpcThenRefresh(fn, wa, btn) {
    if (!sb || !wa) return;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      var res = await sb.rpc(fn, { p_pin: pin, p_mobile: wa });
      if (res.error) throw res.error;
      load(false);   // refresh counts + promoted + waitlist
    } catch (e) { console.error(e); if (btn) { btn.disabled = false; btn.textContent = "Retry"; } }
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
    else if (a === "promote") rpcThenRefresh("promote_waitlister", act.getAttribute("data-wa"), act);
    else if (a === "unpromote") rpcThenRefresh("unpromote_waitlister", act.getAttribute("data-wa"), act);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var kp = $("keypad"); if (kp) kp.addEventListener("click", onKey);
    document.body.addEventListener("click", onClick);
    var s = $("wlSearch"); if (s) s.addEventListener("input", function () { wlFilter = s.value || ""; renderWaitlist(); });
    renderDots();
    try { var saved = sessionStorage.getItem(PIN_KEY); if (saved) { pin = saved; load(true); } } catch (_) {}
  });
})();
