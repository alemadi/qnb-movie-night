/* QNB Movie Night — day-of attendance confirmation (web page)
   Opened from a personal link: confirm.html?t=<ticket_token>
     get_confirm_info(token) -> { found, name, guest_count, hall, attendance, confirmed_count }
     confirm_attendance(token, 'yes'|'no', seats?) ->
       { ok, result, name, hall, guest_count, ticket_token, promoted_* }
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var token = new URLSearchParams(location.search).get("t") || "";
  var info = null;   // get_confirm_info result
  var seats = 1;     // current seat selection

  function $(id) { return document.getElementById(id); }
  var views = ["ask", "seats", "loading", "ticket", "no", "invalid", "error"];
  function show(name) {
    views.forEach(function (v) { var el = $("view-" + v); if (el) el.classList.toggle("hidden", v !== name); });
    window.scrollTo(0, 0);
  }

  function refFromToken(t) { return "TS5-" + String(t).replace(/-/g, "").slice(0, 6).toUpperCase(); }
  function barcodeFromToken(t) {
    var h = String(t).replace(/-/g, "").toUpperCase();
    return h.slice(0, 4) + " " + h.slice(4, 10) + " " + h.slice(10, 16);
  }

  function renderTicket(row) {
    var tk = row.ticket_token || token;
    $("tName").textContent = row.name || "Guest";
    $("tHall").textContent = row.hall || "—";
    $("tGuests").textContent = row.guest_count != null ? String(row.guest_count) : "—";
    $("tRef").textContent = refFromToken(tk);
    $("tBarcodeRef").textContent = barcodeFromToken(tk);
    var qrEl = $("qrCanvas");
    if (window.QRCode && qrEl) {
      qrEl.innerHTML = "";
      new window.QRCode(qrEl, {
        text: String(tk), width: 200, height: 200,
        colorDark: "#0b0e14", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M
      });
    }
    show("ticket");
  }

  function renderSeats() {
    var n = info ? info.guest_count : 1;
    $("bookedN").textContent = n;
    $("seatVal").textContent = seats;
    $("seatBtnN").textContent = seats === 1 ? "1 seat" : seats + " seats";
    var minus = document.querySelector('[data-step="-1"]'), plus = document.querySelector('[data-step="1"]');
    if (minus) minus.disabled = seats <= 1;
    if (plus) plus.disabled = seats >= n;
    var freed = n - seats;
    $("freedNote").textContent = freed > 0
      ? "Releasing " + freed + " seat" + (freed > 1 ? "s" : "") + " to the waitlist 💛" : "";
  }

  async function loadInfo() {
    if (!token) { show("invalid"); return; }
    if (!sb) { show("error"); return; }
    show("loading");
    try {
      var res = await sb.rpc("get_confirm_info", { p_token: token });
      if (res.error) throw res.error;
      info = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!info || !info.found) { show("invalid"); return; }
      if (info.attendance === "yes") {
        renderTicket({ name: info.name, hall: info.hall, ticket_token: token,
          guest_count: info.confirmed_count != null ? info.confirmed_count : info.guest_count });
        return;
      }
      if (info.attendance === "no") { show("no"); return; }
      var first = (info.name || "").split(" ")[0];
      if (first) $("askTitle").textContent = first + ", are you joining us?";
      $("askLead").textContent = "Confirm your " + info.guest_count + " seat" +
        (info.guest_count > 1 ? "s" : "") + " for Toy Story 5 tonight. If your plans changed, you can release seats for the waitlist.";
      seats = info.guest_count;
      show("ask");
    } catch (e) { console.error(e); show("error"); }
  }

  async function submit(answer, s) {
    if (!sb) { show("error"); return; }
    show("loading");
    try {
      var params = { p_token: token, p_answer: answer };
      if (answer === "yes") params.p_seats = s;
      var res = await sb.rpc("confirm_attendance", params);
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row || !row.ok || row.result === "invalid") { show("invalid"); return; }
      if (row.result === "confirmed_yes") renderTicket(row);
      else show("no");
    } catch (e) { console.error(e); show("error"); }
  }

  function onClick(e) {
    var step = e.target.closest("[data-step]");
    if (step) {
      var n = info ? info.guest_count : 1;
      seats = Math.min(Math.max(seats + parseInt(step.getAttribute("data-step"), 10), 1), n);
      renderSeats();
      return;
    }
    var ansBtn = e.target.closest("[data-answer]");
    if (ansBtn) { submit(ansBtn.getAttribute("data-answer")); return; }
    var act = e.target.closest("[data-action]");
    if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "to-seats") { seats = info ? info.guest_count : 1; renderSeats(); show("seats"); }
    else if (a === "back-ask") { show("ask"); }
    else if (a === "confirm-seats") { submit("yes", seats); }
    else if (a === "reload") { location.reload(); }
    else if (a === "screenshot") {
      act.textContent = "📸 Take your screenshot now";
      setTimeout(function () { act.textContent = "📸 Save by screenshot"; }, 2200);
    }
  }

  // preview harness (?preview=ask|seats|yes|no|invalid|error)
  function preview(state) {
    var mock = { ok: true, result: "confirmed_yes", name: "Fatima Al-Naimi", hall: "Hall 4", guest_count: 2, ticket_token: "9214885b-0d26-474f-a7c9-6c0c4f939d3a" };
    info = { found: true, name: "Fatima Al-Naimi", guest_count: 3, hall: "Hall 4", attendance: null, confirmed_count: null };
    if (state === "ask") {
      $("askTitle").textContent = "Fatima, are you joining us?";
      $("askLead").textContent = "Confirm your 3 seats for Toy Story 5 tonight. If your plans changed, you can release seats for the waitlist.";
      seats = 3; show("ask");
    } else if (state === "seats") { seats = 2; renderSeats(); show("seats"); }
    else if (state === "yes") renderTicket(mock);
    else if (state === "no") show("no");
    else if (state === "invalid") show("invalid");
    else if (state === "error") show("error");
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.body.addEventListener("click", onClick);
    var p = new URLSearchParams(location.search).get("preview");
    if (p) { preview(p); return; }
    loadInfo();
  });
})();
