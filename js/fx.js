/* QNB Movie Night — cinematic motion (shared)
   Adds floating light specks, button ripples, and a celebratory confetti burst.
   Dependency-free. Honors prefers-reduced-motion. Exposes window.QNBfx.celebrate().
*/
(function () {
  "use strict";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function sparkles() {
    if (reduce) return;
    var layer = document.createElement("div");
    layer.className = "fx-sparkles";
    for (var i = 0; i < 14; i++) {
      var s = document.createElement("i");
      var size = (Math.random() * 2 + 1.5).toFixed(1);
      s.style.left = (Math.random() * 100).toFixed(2) + "%";
      s.style.width = s.style.height = size + "px";
      s.style.animationDuration = (Math.random() * 9 + 9).toFixed(1) + "s";
      s.style.animationDelay = (-Math.random() * 14).toFixed(1) + "s";
      s.style.opacity = (Math.random() * 0.5 + 0.2).toFixed(2);
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
  }

  function ripples() {
    document.addEventListener("pointerdown", function (e) {
      var b = e.target.closest(".btn, .keypad button, .hall-btns button, .stepper button");
      if (!b || b.disabled) return;
      var rect = b.getBoundingClientRect();
      var d = Math.max(rect.width, rect.height);
      var r = document.createElement("span");
      r.className = "fx-ripple";
      r.style.width = r.style.height = d + "px";
      r.style.left = (e.clientX - rect.left - d / 2) + "px";
      r.style.top = (e.clientY - rect.top - d / 2) + "px";
      if (getComputedStyle(b).position === "static") b.style.position = "relative";
      b.style.overflow = "hidden";
      b.appendChild(r);
      setTimeout(function () { r.remove(); }, 650);
    }, true);
  }

  var COLORS = ["#4D8DFF", "#5FE3E0", "#B5246F", "#EEF2FB"];
  function celebrate() {
    if (reduce) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cv = document.createElement("canvas");
    cv.className = "fx-confetti";
    var W = cv.width = window.innerWidth * dpr, H = cv.height = window.innerHeight * dpr;
    cv.style.width = window.innerWidth + "px"; cv.style.height = window.innerHeight + "px";
    document.body.appendChild(cv);
    var ctx = cv.getContext("2d");
    var parts = [];
    for (var i = 0; i < 90; i++) {
      parts.push({
        x: W * (0.5 + (Math.random() - 0.5) * 0.3), y: H * 0.32 + Math.random() * 20,
        vx: (Math.random() - 0.5) * 10 * dpr, vy: (Math.random() * -8 - 4) * dpr, g: 0.32 * dpr,
        w: (Math.random() * 6 + 4) * dpr, h: (Math.random() * 4 + 3) * dpr,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4, c: COLORS[i % COLORS.length]
      });
    }
    var t0 = performance.now(), DUR = 1500;
    function frame(t) {
      var el = t - t0;
      ctx.clearRect(0, 0, W, H);
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k];
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - el / DUR);
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (el < DUR) requestAnimationFrame(frame); else cv.remove();
    }
    requestAnimationFrame(frame);
  }

  function backdrop() {
    if (document.querySelector(".bg-photo")) return;
    var d = document.createElement("div"); d.className = "bg-photo";
    document.body.appendChild(d);
  }

  // Live countdown to showtime (Sat 20 June 2026, 4:00 PM Qatar / UTC+3)
  function countdown() {
    var el = document.getElementById("countdown"); if (!el) return;
    var target = new Date("2026-06-20T16:00:00+03:00").getTime();
    function u(v, l) { return '<div class="cd-unit"><div class="cd-num">' + v + '</div><div class="cd-lbl">' + l + "</div></div>"; }
    function tick() {
      var diff = target - Date.now();
      if (diff <= 0) { el.innerHTML = '<div class="cd-now">🎬 Now showing</div>'; return; }
      var d = Math.floor(diff / 864e5), h = Math.floor(diff / 36e5) % 24, m = Math.floor(diff / 6e4) % 60;
      el.innerHTML = u(d, "days") + '<div class="cd-sep">:</div>' + u(h, "hrs") + '<div class="cd-sep">:</div>' + u(m, "min");
    }
    tick(); setInterval(tick, 30000);
  }

  // Add-to-calendar: universal .ics (iOS opens Calendar, Android opens Google Cal).
  // Showtime 4:00 PM Qatar (+03) = 13:00 UTC; end 6:30 PM = 15:30 UTC.
  function addToCalendar() {
    var ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//QNB Movie Night//EN", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:qnb-movie-night-toystory5@alemadi.github.io",
      "DTSTAMP:20260619T000000Z",
      "DTSTART:20260620T130000Z",
      "DTEND:20260620T153000Z",
      "SUMMARY:QNB Movie Night — Toy Story 5",
      "LOCATION:Novo Cinemas, Doha Oasis",
      "DESCRIPTION:Doors from 3:30 PM. Show your QR ticket at the entrance.",
      "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
    var url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url; a.download = "qnb-movie-night.ics";
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  window.QNBfx = { celebrate: celebrate, addToCalendar: addToCalendar };
  document.addEventListener("DOMContentLoaded", function () { backdrop(); sparkles(); ripples(); countdown(); });
})();
