// The hero sky: Sagittarius, drawn from its real star positions. Seven of its stars are the seven slots of the quiver,
// sized by share; the eighth (Alnasl, the arrowhead) is CHIRON's own. The lines draw themselves once, arrows of light
// fly to the seven, and the field twinkles and leans a little with the pointer. With reduced motion it is one still frame.
window.Sky = (function () {
  // normalized from right ascension / declination (east is left, as on a star chart)
  const STARS = { tau: [0, 0.17], zeta: [0.072, 0.337], sigma: [0.191, 0.067], phi: [0.348, 0.119], lambda: [0.638, 0], epsilon: [0.7, 0.677], delta: [0.752, 0.333], gamma: [1, 0.378] };
  const LINES = [["gamma", "delta"], ["delta", "lambda"], ["delta", "epsilon"], ["gamma", "epsilon"], ["lambda", "phi"], ["delta", "phi"], ["phi", "sigma"], ["sigma", "tau"], ["tau", "zeta"], ["zeta", "phi"], ["zeta", "epsilon"]];
  const SLOTS = ["delta", "lambda", "epsilon", "phi", "sigma", "zeta", "tau"];          // the heaviest member takes the middle of the bow
  const LABEL = { delta: [16, 6, "l"], lambda: [0, -50, "c"], epsilon: [0, 18, "c"], phi: [6, -50, "c"], sigma: [-6, -50, "c"], zeta: [-22, -44, "r"], tau: [-16, -14, "r"] };
  // on a phone the sky is narrow: two labels move so none leaves the screen or sits on another
  const LABEL_NARROW = { ...LABEL, zeta: [0, 18, "c"], tau: [0, 16, "c"], phi: [10, 10, "l"], delta: [14, -40, "l"] };
  const EMBER = "255,177,85", ICE = "190,214,255";

  /** avoid: an element (the headline) whose top edge the left half of the constellation must stay above */
  function init(canvas, labels, avoid) {
    const ctx = canvas.getContext("2d"), still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, dpr = 1, field = [], pos = {}, members = [], arrows = [], flash = {}, t0 = performance.now(), on = true, raf = 0;
    let px = 0, py = 0, tx = 0, ty = 0, lastAmbient = 0, opened = false, narrow = false, compact = false;

    function layout() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      narrow = W < 760;
      // wide screens: as large as fits above the headline, or beside it when the screen is short
      const limit = avoid ? avoid.getBoundingClientRect().top - r.top : H * 0.42;
      const right = avoid ? Math.max(...[...avoid.children].map((c) => c.getBoundingClientRect().right)) - r.left : W * 0.5;
      const above = (limit - 116 - 18) / 0.337, beside = W * 0.9 - right - 56;
      const bw = narrow ? W * 0.64 : Math.max(260, Math.min(W * 0.42, Math.max(above, beside)));
      const x0 = narrow ? W * 0.17 : W * 0.9 - bw, y0 = narrow ? 128 : above >= beside ? 116 : Math.max(116, (H - bw * 0.677) / 2 - 40);
      compact = narrow || bw < 480;
      pos = Object.fromEntries(Object.entries(STARS).map(([k, [x, y]]) => [k, { x: x0 + x * bw, y: y0 + y * bw }]));
      const n = Math.min(520, Math.round((W * H) / 2600));
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      field = Array.from({ length: n }, () => ({ x: rnd(), y: Math.pow(rnd(), 1.25), r: 0.35 + Math.pow(rnd(), 4) * 1.5, ph: rnd() * 6.28, sp: 0.4 + rnd() * 1.6, d: 0.2 + rnd() * 0.8, warm: rnd() > 0.86 }));
      place();
      if (still) frame(performance.now());
    }

    function place() {
      if (!labels) return;
      labels.innerHTML = "";
      members.slice(0, SLOTS.length).forEach((m, i) => {
        const key = SLOTS[i], p = pos[key], [dx, dy, al] = (compact ? LABEL_NARROW : LABEL)[key];
        const a = document.createElement("a");
        a.href = m.href || "#"; a.target = "_blank"; a.rel = "noopener";
        const b = document.createElement("b"); b.textContent = "$" + m.symbol; a.append(b, `${Math.round(m.weight * 100)}%${compact ? "" : " of each buy"}`);
        a.style.transform = `translate(${(p.x + dx).toFixed(1)}px,${(p.y + dy).toFixed(1)}px)` + (al === "c" ? " translateX(-50%)" : al === "r" ? " translateX(-100%)" : "");
        labels.append(a);
        if (still || opened) a.classList.add("on"); else setTimeout(() => a.classList.add("on"), 2300 + i * 110);
      });
    }

    const ease = (x) => 1 - Math.pow(1 - x, 3);
    function loose(from, to, delay = 0, key = null, dur = 900) {
      arrows.push({ from, to, t: performance.now() + delay, dur, key, bend: (Math.random() - 0.5) * 0.18 });
    }
    /** seven arrows from one point to the seven stars */
    function volley(from) {
      if (still) return;
      const o = from || { x: W * 0.1, y: H * 0.9 };
      SLOTS.forEach((k, i) => { if (members[i]) loose(o, pos[k], i * 95, k, 850 + i * 30); });
    }

    function star(x, y, r, rgb, a) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 7);
      g.addColorStop(0, `rgba(${rgb},${0.55 * a})`); g.addColorStop(0.25, `rgba(${rgb},${0.16 * a})`); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 7, 0, 6.2832); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    }

    function frame(now) {
      const t = (now - t0) / 1000;
      px += (tx - px) * 0.05; py += (ty - py) * 0.05;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

      // slow haze: three soft clouds of colour that drift
      for (const [cx, cy, rr, col, sp] of [[0.72, 0.36, 0.5, "120,112,255,.16", 0.05], [0.3, 0.2, 0.42, "70,130,255,.10", 0.035], [0.55, 1.02, 0.55, "255,140,90,.13", 0.045]]) {
        const x = (cx + Math.sin(t * sp + cx * 9) * 0.04) * W, y = (cy + Math.cos(t * sp * 1.3 + cy * 7) * 0.03) * H, R = rr * Math.max(W, H);
        const g = ctx.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, `rgba(${col})`); g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      // the field
      for (const s of field) {
        const a = still ? 0.7 : 0.45 + 0.55 * Math.sin(t * s.sp + s.ph) ** 2;
        ctx.fillStyle = s.warm ? `rgba(255,214,170,${a * 0.9})` : `rgba(226,232,255,${a * 0.85})`;
        ctx.beginPath(); ctx.arc(s.x * W + px * s.d * 16, s.y * H + py * s.d * 10, s.r, 0, 6.2832); ctx.fill();
      }
      const P = (k) => ({ x: pos[k].x + px * 26, y: pos[k].y + py * 16 });

      // the constellation lines draw themselves, one after the other
      ctx.lineWidth = 1;
      LINES.forEach(([a, b], i) => {
        const k = still || opened ? 1 : Math.max(0, Math.min(1, (t - 0.5 - i * 0.16) / 0.5));
        if (k <= 0) return;
        const A = P(a), B = P(b), e = ease(k);
        ctx.strokeStyle = `rgba(${ICE},${0.34})`;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * e); ctx.stroke();
      });
      if (!opened && t > 2.4) { opened = true; volley(); lastAmbient = now; }

      // the seven slots
      SLOTS.forEach((k, i) => {
        const p = P(k), m = members[i], f = flash[k] ? Math.max(0, 1 - (now - flash[k]) / 900) : 0;
        if (!m) { ctx.strokeStyle = `rgba(${ICE},.45)`; ctx.beginPath(); ctx.arc(p.x, p.y, 3.2, 0, 6.2832); ctx.stroke(); return; }
        const r = 1.9 + m.weight * 9 + f * 2.5, breathe = still ? 1 : 0.86 + 0.14 * Math.sin(t * 1.1 + i * 1.7);
        star(p.x, p.y, r, f > 0.02 ? EMBER : ICE, Math.min(1, breathe + f));
      });
      // Alnasl, the arrowhead
      { const p = P("gamma"), r = 3.1, a = still ? 1 : 0.85 + 0.15 * Math.sin(t * 1.6);
        star(p.x, p.y, r, EMBER, a);
        ctx.strokeStyle = `rgba(${EMBER},${0.75 * a})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x - 13, p.y); ctx.lineTo(p.x + 13, p.y); ctx.moveTo(p.x, p.y - 13); ctx.lineTo(p.x, p.y + 13); ctx.stroke(); }

      // every few seconds the bow looses one arrow past the arrowhead
      if (!still && opened && now - lastAmbient > 6500) {
        lastAmbient = now;
        const d = P("delta"), g = P("gamma");
        loose({ x: d.x, y: d.y }, { x: g.x + (g.x - d.x) * 5, y: g.y + (g.y - d.y) * 5 }, 0, null, 1500);
      }
      // arrows of light
      arrows = arrows.filter((a) => now < a.t + a.dur + 350);
      for (const a of arrows) {
        if (now < a.t) continue;
        const k = Math.min(1, (now - a.t) / a.dur), e = ease(k), fade = k < 1 ? 1 : Math.max(0, 1 - (now - a.t - a.dur) / 350);
        const mx = (a.from.x + a.to.x) / 2 + (a.to.y - a.from.y) * a.bend, my = (a.from.y + a.to.y) / 2 - (a.to.x - a.from.x) * a.bend;
        const at = (u) => ({ x: (1 - u) * (1 - u) * a.from.x + 2 * (1 - u) * u * mx + u * u * a.to.x, y: (1 - u) * (1 - u) * a.from.y + 2 * (1 - u) * u * my + u * u * a.to.y });
        const head = at(e), tail = at(Math.max(0, e - 0.22));
        const g = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        g.addColorStop(0, `rgba(${EMBER},0)`); g.addColorStop(1, `rgba(${EMBER},${0.95 * fade})`);
        ctx.strokeStyle = g; ctx.lineWidth = 1.6; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y);
        for (let u = 0.2; u <= 1.001; u += 0.2) { const q = at(Math.max(0, e - 0.22 + 0.22 * u)); ctx.lineTo(q.x, q.y); }
        ctx.stroke();
        ctx.fillStyle = `rgba(255,236,210,${fade})`; ctx.beginPath(); ctx.arc(head.x, head.y, 1.8, 0, 6.2832); ctx.fill();
        if (k >= 1 && a.key && !a.hit) { a.hit = true; flash[a.key] = now; }
      }
      raf = on && !still ? requestAnimationFrame(frame) : 0;
    }

    const wake = () => { if (on && !raf && !still) raf = requestAnimationFrame(frame); };
    layout();
    addEventListener("resize", layout);
    document.fonts?.ready.then(layout);                          // the headline moves once its font arrives
    if (!still) {
      addEventListener("pointermove", (e) => { tx = e.clientX / innerWidth - 0.5; ty = e.clientY / innerHeight - 0.5; }, { passive: true });
      new IntersectionObserver(([e]) => { on = e.isIntersecting && !document.hidden; wake(); }).observe(canvas);
      document.addEventListener("visibilitychange", () => { on = !document.hidden; wake(); });
      raf = requestAnimationFrame(frame);
    }
    return {
      /** members: [{ symbol, weight, href }], heaviest first */
      setMembers(list) { const same = JSON.stringify(list) === JSON.stringify(members); members = list; if (!same) { place(); if (still) frame(performance.now()); } },
      volley,
    };
  }
  return { init };
})();
