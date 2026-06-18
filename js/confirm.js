/* QNB Movie Night — day-of attendance confirmation (web page)
   Opened from a personal link: confirm.html?t=<ticket_token>
   confirm_attendance(p_token, p_answer) ->
     { ok, result, name, hall, guest_count, ticket_token, promoted_* }
*/
(function () {
  "use strict";

  var cfg = window.QNB_CONFIG || {};
  var sb = (window.supabase && cfg.SUPABASE_URL)
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  var token = new URLSearchParams(location.search).get("t") || "";

  function $(id) { return document.getElementById(id); }
  var views = ["ask", "loading", "ticket", "no", "invalid", "error"];
  function show(name) {
    views.forEach(function (v) { var el = $("view-" + v); if (el) el.classList.toggle("hidden", v !== name); });
    window.scrollTo(0, 0);
  }
  function askMsg(text, kind) {
    var m = $("askMsg"); if (!m) return;
    if (!text) { m.className = "msg"; m.textContent = ""; return; }
    m.className = "msg show " + (kind || "error"); m.textContent = text;
  }

  function refFromToken(t) { return "TS5-" + String(t).replace(/-/g, "").slice(0, 6).toUpperCase(); }
  function barcodeFromToken(t) {
    var h = String(t).replace(/-/g, "").toUpperCase();
    return h.slice(0, 4) + " " + h.slice(4, 10) + " " + h.slice(10, 16);
  }

  function renderTicket(row) {
    $("tName").textContent = row.name || "Guest";
    $("tHall").textContent = row.hall || "—";
    $("tGuests").textContent = row.guest_count != null ? String(row.guest_count) : "—";
    $("tRef").textContent = refFromToken(row.ticket_token);
    $("tBarcodeRef").textContent = barcodeFromToken(row.ticket_token);
    var qrEl = $("qrCanvas");
    if (window.QRCode && qrEl) {
      qrEl.innerHTML = "";
      new window.QRCode(qrEl, {
        text: String(row.ticket_token), width: 200, height: 200,
        colorDark: "#0b0e14", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M
      });
    }
    show("ticket");
  }

  async function answer(ans) {
    if (!token) { show("invalid"); return; }
    if (!sb) { askMsg("Service unavailable. Please see a staff member.", "error"); return; }
    show("loading");
    try {
      var res = await sb.rpc("confirm_attendance", { p_token: token, p_answer: ans });
      if (res.error) throw res.error;
      var row = Array.isArray(res.data) ? res.data[0] : res.data;
      if (!row || !row.ok || row.result === "invalid") { show("invalid"); return; }
      if (row.result === "confirmed_yes") { renderTicket(row); }
      else { show("no"); }
    } catch (err) {
      console.error(err);
      show("error");
    }
  }

  function onClick(e) {
    var ansBtn = e.target.closest("[data-answer]");
    if (ansBtn) { answer(ansBtn.getAttribute("data-answer")); return; }
    var act = e.target.closest("[data-action]");
    if (!act) return;
    var a = act.getAttribute("data-action");
    if (a === "reload") location.reload();
    else if (a === "screenshot") {
      act.textContent = "📸 Take your screenshot now";
      setTimeout(function () { act.textContent = "📸 Save by screenshot"; }, 2200);
    }
  }

  // preview harness (?preview=ask|yes|no|invalid|error)
  function preview(state) {
    var mock = { ok: true, result: "confirmed_yes", name: "Fatima Al-Naimi", hall: "Hall 4", guest_count: 3, ticket_token: "9214885b-0d26-474f-a7c9-6c0c4f939d3a" };
    if (state === "ask") show("ask");
    else if (state === "yes") renderTicket(mock);
    else if (state === "no") show("no");
    else if (state === "invalid") show("invalid");
    else if (state === "error") show("error");
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.body.addEventListener("click", onClick);
    var qp = new URLSearchParams(location.search);
    var p = qp.get("preview");
    if (p) { preview(p); return; }
    if (!token) { show("invalid"); return; }
    // Deep link from the WhatsApp "you're confirmed" reply -> show ticket directly.
    if (qp.get("go") === "yes") { answer("yes"); return; }
    show("ask");
  });
})();
