/* QNB Movie Night — organizer dashboard (admin.html)
   PIN gate -> live counts, per-hall occupancy, promoted (Notify/Undo),
   manual waitlist promotion, and adding walk-in / non-registered guests.
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
  var waitlist = [];
  var wlFilter = "";
  var walkSeats = 1;
  var walkHall = null;

  function $(id) { return document.getElementById(id); }
  function showView(name) {
    ["pin", "dash"].forEach(function (v) { var el = $("view-" + v); if (el) el.classList.toggle("hidden", v !== name); });
    window.scrollTo(0, 0);
  }
  function pinMsg(t, k) { var m = $("pinMsg"); if (!m) return; if (!t) { m.className = "msg"; m.textContent = ""; return; } m.className = "msg show " + (k || "error"); m.textContent = t; }
  function wkMsg(t, k) { var m = $("wkMsg"); if (!m) return; if (!t) { m.className = "msg"; m.textContent = ""; return; } m.className = "msg show " + (k || "error"); m.textContent = t; }

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

  function rowEl(name, sub) {
    var r = document.createElement("div"); r.className = "promo-row";
    var who = document.createElement("div"); who.className = "who";
    who.innerHTML = "<b></b><small></small>";
    who.querySelector("b").textContent = name || "Guest";
    who.querySelector("small").textContent = sub;
    r.appendChild(who);
    return r;
  }

  // ---- hall occupancy ----
  function renderHall(prefix, filled, cap) {
    var txt = $(prefix + "txt"), bar = $(prefix + "bar"), sub = $(prefix + "sub");
    if (!txt) return;
    txt.textContent = filled + " / " + cap;
    var pct = cap > 0 ? Math.min(100, Math.round(filled / cap * 100)) : 0;
    if (bar) {
      bar.style.width = pct + "%";
      bar.classList.toggle("full", filled >= cap && cap > 0);
      bar.classList.toggle("warn", filled < cap && pct >= 80);
    }
    if (sub) {
      if (cap <= 0) sub.textContent = "";
      else if (filled < cap) sub.textContent = (cap - filled) + " seat" + (cap - filled !== 1 ? "s" : "") + " free";
      else if (filled === cap) sub.textContent = "Full";
      else sub.textContent = "⚠️ over by " + (filled - cap);
    }
  }

  function render(d) {
    $("sCheckedIn").innerHTML = d.checked_in + ' <small>/ ' + d.checked_in_heads + " seats</small>";
    $("sConfirmed").innerHTML = d.confirmed + ' <small>/ ' + d.confirmed_heads + " seats</small>";
    $("sYes").textContent = d.attending_yes;
    $("sDeclined").textContent = d.declined;

    renderHall("h3", d.hall3_filled || 0, d.hall3_cap || 0);
    renderHall("h4", d.hall4_filled || 0, d.hall4_cap || 0);
    var un = $("unassignedNote");
    if (un) un.textContent = (d.unassigned_in > 0) ? ("⚠️ " + d.unassigned_in + " checked-in seat(s) not yet assigned to a hall.") : "";

    updateWalkin(d);

    var list = d.promoted_pending || [];
    $("promoCount").textContent = list.length ? "(" + list.length + ")" : "";
    var host = $("promoList"); host.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div"); e.className = "empty-note";
      e.textContent = "No one promoted yet. Promote from the waitlist below.";
      host.appendChild(e);
    } else {
      list.forEach(function (g) {
        var r = rowEl(g.name, "+" + (g.wa_phone || "—") + " · " + (g.seats || 1) + " seat(s)");
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
      var r = rowEl(g.name, "+" + (g.wa_phone || "—") + " · " + (g.seats || 1) + " seat(s)");
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
      load(false);
    } catch (e) { console.error(e); if (btn) { btn.disabled = false; btn.textContent = "Retry"; } }
  }

  // ---- walk-in ----
  // Reflect capacity: block adding once the venue (or chosen hall) is full.
  function updateWalkin(d) {
    var capTotal = (d.hall3_cap || 0) + (d.hall4_cap || 0);
    var total = d.checked_in_heads || 0;
    var venueFull = capTotal > 0 && total >= capTotal;
    var h3full = (d.hall3_cap || 0) > 0 && (d.hall3_filled || 0) >= d.hall3_cap;
    var h4full = (d.hall4_cap || 0) > 0 && (d.hall4_filled || 0) >= d.hall4_cap;

    [].forEach.call(document.querySelectorAll(".hallpick"), function (b) {
      var h = b.getAttribute("data-wkhall");
      b.disabled = venueFull || (h === "Hall 3" ? h3full : h4full);
    });
    if (venueFull || (walkHall === "Hall 3" && h3full) || (walkHall === "Hall 4" && h4full)) setWalkHall(null);

    var addBtn = document.querySelector('[data-action="addwalkin"]');
    if (addBtn) addBtn.disabled = venueFull || (h3full && h4full);

    var av = $("wkAvail");
    if (av) av.innerHTML = venueFull
      ? '<b style="color:#E2604D">🔴 Venue full — ' + total + '/' + capTotal + ' checked in. Can\'t add more.</b>'
      : (total + ' / ' + capTotal + ' seats checked in' + (h3full ? ' · Hall 3 full' : '') + (h4full ? ' · Hall 4 full' : '') + '.');
  }

  function setWalkHall(h) {
    walkHall = h;
    [].forEach.call(document.querySelectorAll(".hallpick"), function (b) {
      b.classList.toggle("sel", b.getAttribute("data-wkhall") === h);
    });
  }
  async function addWalkin(btn) {
    if (!sb) return;
    var name = ($("wkName").value || "").trim();
    if (!name) { wkMsg("Enter the guest's name.", "error"); return; }
    if (!walkHall) { wkMsg("Pick a hall.", "error"); return; }
    wkMsg("Adding…", "info");
    if (btn) btn.disabled = true;
    try {
      var res = await sb.rpc("add_walkin", { p_pin: pin, p_name: name, p_seats: walkSeats, p_hall: walkHall });
      if (res.error) throw res.error;
      var r = res.data;
      if (!r || !r.ok) { wkMsg((r && r.reason) ? r.reason : "Couldn't add.", "error"); if (btn) btn.disabled = false; return; }
      wkMsg("✓ Added " + r.name + " (" + r.seats + " seat" + (r.seats > 1 ? "s" : "") + ") to " + r.hall + ".", "info");
      $("wkName").value = ""; walkSeats = 1; $("wkSeats").textContent = "1"; setWalkHall(null);
      load(false);
    } catch (e) { console.error(e); wkMsg("No connection — try again.", "error"); }
    if (btn) btn.disabled = false;
  }

  function lock() {
    pin = ""; renderDots();
    try { sessionStorage.removeItem(PIN_KEY); } catch (_) {}
    if (timer) { clearInterval(timer); timer = null; }
    showView("pin");
  }

  function onClick(e) {
    var ws = e.target.closest("[data-wstep]");
    if (ws) { walkSeats = Math.min(Math.max(walkSeats + parseInt(ws.getAttribute("data-wstep"), 10), 1), 20); $("wkSeats").textContent = walkSeats; return; }
    var wh = e.target.closest("[data-wkhall]");
    if (wh) { setWalkHall(wh.getAttribute("data-wkhall")); return; }
    var act = e.target.closest("[data-action]"); if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "refresh") load(false);
    else if (a === "lock") lock();
    else if (a === "promote") rpcThenRefresh("promote_waitlister", act.getAttribute("data-wa"), act);
    else if (a === "unpromote") rpcThenRefresh("unpromote_waitlister", act.getAttribute("data-wa"), act);
    else if (a === "addwalkin") addWalkin(act);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var kp = $("keypad"); if (kp) kp.addEventListener("click", onKey);
    document.body.addEventListener("click", onClick);
    var s = $("wlSearch"); if (s) s.addEventListener("input", function () { wlFilter = s.value || ""; renderWaitlist(); });
    renderDots();
    try { var saved = sessionStorage.getItem(PIN_KEY); if (saved) { pin = saved; load(true); } } catch (_) {}
  });
})();
