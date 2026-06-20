/* QNB Movie Night — VIP personal invitation (invite.html?t=<token>)
   Token-based: greets the guest, lets them reserve N seats or decline.
   Wired to the same get_confirm_info / confirm_attendance RPCs as confirm.html.
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var token = new URLSearchParams(location.search).get("t") || "";
  var info = null, seats = 2;

  function $(id) { return document.getElementById(id); }
  var views = ["load", "invite", "seats", "yes", "no", "err"];
  function show(n) { views.forEach(function (v) { var e = $("v-" + v); if (e) e.classList.toggle("hidden", v !== n); }); window.scrollTo(0, 0); }
  function first(name) { return (String(name || "").trim().split(" ")[0]) || "there"; }
  function cap() { return info && info.guest_count ? info.guest_count : 6; }

  function renderSeats() {
    $("seatVal").textContent = seats;
    $("seatN").textContent = seats === 1 ? "1 seat" : seats + " seats";
    var m = document.querySelector('[data-step="-1"]'), p = document.querySelector('[data-step="1"]');
    if (m) m.disabled = seats <= 1;
    if (p) p.disabled = seats >= cap();
  }

  function showYes(n) {
    $("yesTitle").textContent = "Thank you, " + first(info && info.name);
    $("yesLead").innerHTML = "We have reserved <b>" + n + "</b> seat" + (n > 1 ? "s" : "") + " in your name for the premiere.";
    // VIP pass: encode the ticket token (from the URL) as a QR for door check-in
    var qrText = token || "PREVIEW";
    var holder = $("vipQr"), pass = $("vipPass");
    if (holder && pass && window.QRCode) {
      holder.innerHTML = "";
      new window.QRCode(holder, { text: qrText, width: 168, height: 168, colorDark: "#0b0e14", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
      pass.classList.remove("hidden");
    }
    show("yes");
  }

  async function loadInfo() {
    if (!sb) { show("err"); return; }
    show("load");
    try {
      var res = await sb.rpc("get_confirm_info", { p_token: token });
      if (res.error) throw res.error;
      info = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!info || !info.found) { show("err"); return; }
      if (info.name) $("vName").textContent = first(info.name);
      if (info.attendance === "yes") { showYes(info.confirmed_count != null ? info.confirmed_count : info.guest_count); return; }
      if (info.attendance === "no") { show("no"); return; }
      seats = Math.min(2, cap()); if (seats < 1) seats = 1;
      show("invite");
    } catch (e) { console.error(e); show("err"); }
  }

  async function submit(answer, s) {
    if (!sb) { show("err"); return; }
    show("load");
    try {
      var p = { p_token: token, p_answer: answer };
      if (answer === "yes") p.p_seats = s;
      var res = await sb.rpc("confirm_attendance", p);
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row || !row.ok) { show("err"); return; }
      if (row.result === "confirmed_yes") showYes(row.guest_count); else show("no");
    } catch (e) { console.error(e); show("err"); }
  }

  function onClick(e) {
    var st = e.target.closest("[data-step]");
    if (st) { seats = Math.min(Math.max(seats + parseInt(st.getAttribute("data-step"), 10), 1), cap()); renderSeats(); return; }
    var a = e.target.closest("[data-act]"); if (!a) return;
    var act = a.getAttribute("data-act");
    if (act === "accept") { seats = Math.min(2, cap()); if (seats < 1) seats = 1; renderSeats(); show("seats"); }
    else if (act === "back") show("invite");
    else if (act === "confirm") submit("yes", seats);
    else if (act === "decline") submit("no");
    else if (act === "reconsider") { renderSeats(); show("seats"); }   // note: only re-reserves if not already locked server-side
    else if (act === "reload") location.reload();
  }

  // preview harness (?preview=invite|seats|yes|no)
  function preview(s) {
    info = { found: true, name: "Heba", guest_count: 6, attendance: null, confirmed_count: null };
    $("vName").textContent = "Heba";
    if (s === "seats") { seats = 4; renderSeats(); show("seats"); }
    else if (s === "yes") showYes(4);
    else if (s === "no") show("no");
    else show("invite");
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.body.addEventListener("click", onClick);
    var pv = new URLSearchParams(location.search).get("preview");
    if (pv) { preview(pv); return; }
    if (token) { loadInfo(); return; }
    preview("invite");   // no token -> show the invitation design (demo)
  });
})();
