/* Catch-up mode look: aqua colours, bubbles and sparks, and glowing liquid in every card. The liquid is a
   shallow-water simulation (120 columns per card, drawn as a smooth curve). It is mostly calm with a slow sway,
   and now and then a wave of random strength and speed rolls through or something drops in; strong waves throw
   spray and leave foam.
   One animation loop for everything; it sleeps while the app is hidden. */
(function (root) {
  'use strict';
  let on = false, raf = 0, bg = null, zap = null, lastT = 0, frameAvg = 16, lite = false;
  // No sensors: every card's liquid has its own quiet weather (see weather()). grav only drifts the bubbles.
  const grav = { x: 0, y: 1 };
  const sims = new Map(); // card -> liquid state
  const bubbles = []; // background bubbles
  let sparkAt = 0, spark = null, zapDirty = false;
  const DPR = () => Math.min(2, root.devicePixelRatio || 1);
  /** Kept so the app can still call it; the liquid no longer uses the phone's sensors. */
  function askMotion() {}

  function layer(id, z) {
    const c = document.createElement('canvas');
    c.id = id; c.className = 'fx-layer'; c.style.zIndex = z;
    document.body.appendChild(c);
    return c;
  }
  // the glow layers are soft anyway: drawing them at 1x keeps the phone at full frame rate
  function fit(c, maxR) {
    const r = Math.min(DPR(), maxR || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
    return { w, h, r };
  }

  // ---- liquid: 1D shallow water. h = depth per column, u = speed across each column boundary ----
  const N = 120, G = 3600, SUB = 1 / 240, CS = 120 / N; // columns, px/s² for 1 g, physics step, column scale vs the old 120
  function simFor(card) {
    let s = sims.get(card);
    if (s && s.canvas.isConnected) return s;
    const canvas = document.createElement('canvas');
    canvas.className = 'liquid';
    card.prepend(canvas);
    s = { canvas, h: new Float32Array(N), prev: new Float32Array(N), u: new Float32Array(N + 1), out: new Float32Array(N + 1), rise: new Float32Array(N), foam: new Float32Array(N), drops: [], bub: [], acc: 0, level: 0, w: 0 };
    sims.set(card, s);
    return s;
  }
  function physics(s, w, H, dts) {
    const level = Math.min(Math.max(H * 0.26, 22), 80);
    if (s.level !== level || s.w !== w) { // new or resized card: refill to the level, keep the motion
      const mass = s.level ? s.h.reduce((a, b) => a + b, 0) : 0;
      if (!mass) s.h.fill(level); else { const k = (level * N) / mass; for (let i = 0; i < N; i++) s.h[i] *= k; }
      s.level = level; s.w = w;
    }
    const dx = w / N, h = s.h, u = s.u;
    // flat phone: keep some "down" so the liquid still settles
    const gx = Math.max(-1.5, Math.min(1.5, s.gx || 0)) * G, gy = G;
    const vmax = (0.45 * dx) / dts, q = dts / SUB;
    s.prev.set(h);
    for (let j = 1; j < N; j++) {
      let v = u[j] + dts * (gx - (gy * (h[j] - h[j - 1])) / dx);
      v += Math.min(0.45, 0.16 * q) * (u[j - 1] + u[j + 1] - 2 * u[j]); // viscosity: thick, heavy liquid
      if (j > 1 && j < N - 1) v += Math.min(0.2, 0.07 * q) * (u[j - 2] + u[j + 2] - 2 * u[j]); // and over 2 columns, so a jolt spreads over 4
      v *= 1 - 0.9 * dts; // friction
      if (h[j] + h[j - 1] < 0.5) v = 0;
      u[j] = v > vmax ? vmax : v < -vmax ? -vmax : v;
    }
    u[0] = 0; u[N] = 0;
    // move the water (upwind), never below empty
    const out = s.out; out[0] = 0; out[N] = 0;
    for (let j = 1; j < N; j++) out[j] = u[j] * (u[j] > 0 ? h[j - 1] : h[j]) * (dts / dx);
    for (let i = 0; i < N; i++) {
      const give = Math.max(0, out[i + 1]) + Math.max(0, -out[i]);
      if (give > h[i] && give > 0) { const k = h[i] / give; if (out[i + 1] > 0) out[i + 1] *= k; if (out[i] < 0) out[i] *= k; }
    }
    for (let i = 0; i < N; i++) h[i] = Math.max(0, h[i] - out[i + 1] + out[i]);
    // Smooth out column-to-column zigzags (they turn the surface into a saw blade after hard shakes) while
    // leaving real waves almost untouched. Moves water between neighbours only, so none is lost.
    const sm = s.out; // reuse as scratch: flow between i-1 and i
    const cs = Math.min(0.3, 0.06 * q);
    for (let i = 1; i < N; i++) sm[i] = cs * (h[i - 1] - h[i]);
    for (let i = 1; i < N; i++) { const f = sm[i] > 0 ? Math.min(sm[i], h[i - 1]) : Math.max(sm[i], -h[i]); h[i - 1] -= f; h[i] += f; }
    // the same between columns two apart: a sudden wave is shared by 3 to 4 columns instead of making a spike
    const cs2 = cs * 0.5;
    for (let i = 2; i < N; i++) { let f = cs2 * (h[i - 2] - h[i]); f = f > 0 ? Math.min(f, h[i - 2]) : Math.max(f, -h[i]); h[i - 2] -= f; h[i] += f; }
    // a column can't tower over the card: what's above the cap spills to its neighbours
    const cap = Math.min(H - 6, s.level * 3.2);
    for (let i = 0; i < N; i++) if (h[i] > cap) {
      const ex = h[i] - cap; h[i] = cap;
      if (i === 0) h[1] += ex; else if (i === N - 1) h[N - 2] += ex; else { h[i - 1] += ex / 2; h[i + 1] += ex / 2; }
    }
    // Springy surface: no step between two columns may be steeper than about 42 degrees. Anything steeper is
    // shared out between them at once (water only moves, none is lost), so a hard swing makes a rounded hump,
    // never a wall of water.
    const lim = 0.9 * dx;
    for (let pass = 0; pass < 12; pass++) {
      const fwd = pass % 2 === 0;
      let worst = 0;
      for (let k = 1; k < N; k++) {
        const i = fwd ? k : N - k;
        const d = h[i - 1] - h[i];
        if (d > lim) { const f = Math.min((d - lim) * 0.5, h[i - 1]); h[i - 1] -= f; h[i] += f; worst = Math.max(worst, d - lim); }
        else if (d < -lim) { const f = Math.min((-d - lim) * 0.5, h[i]); h[i] -= f; h[i - 1] += f; worst = Math.max(worst, -d - lim); }
      }
      if (worst < 0.05) break;
    }
    return { gx, gy, dx };
  }
  /* The weather of one card's liquid: a slow, barely-there sway, and every 3 to 15 s an event: usually a gentle
     push that rolls a wave across, sometimes a strong one, sometimes a drop falling in at a random spot. Each card
     has its own, so they don't move in step. */
  function weather(s, dt) {
    s.wt = (s.wt || 0) + dt;
    if (s.ph === undefined) { s.ph = Math.random() * 6.28; s.next = 3 + Math.random() * 8; }
    if (s.wt >= s.next) {
      const strong = Math.random() < 0.18, dir = Math.random() < 0.5 ? -1 : 1;
      if (Math.random() < 0.35) { // a drop falls in: a bump that spreads out as rings of waves
        const c = 8 + Math.random() * (N - 16), wd = 3 + Math.random() * 6, amp = (strong ? 18 : 5) + Math.random() * (strong ? 20 : 10);
        let add = 0; const bump = new Float32Array(N);
        for (let i = 0; i < N; i++) { bump[i] = amp * Math.exp(-((i - c) * (i - c)) / (2 * wd * wd)); add += bump[i]; }
        for (let i = 0; i < N; i++) s.h[i] = Math.max(0, s.h[i] + bump[i] - add / N);
      } else {
        s.ev = { t0: s.wt, dur: 0.3 + Math.random() * (strong ? 0.6 : 1.4), amp: dir * (strong ? 0.45 + Math.random() * 0.55 : 0.06 + Math.random() * 0.22) };
      }
      s.next = s.wt + 3 + Math.random() * 12;
    }
    let gx = Math.sin(s.wt * 0.31 + s.ph) * 0.035 + Math.sin(s.wt * 0.093 + s.ph * 2) * 0.045;
    if (s.ev) {
      const q = (s.wt - s.ev.t0) / s.ev.dur;
      if (q >= 1) s.ev = null; else gx += s.ev.amp * Math.sin(Math.PI * q);
    }
    s.gx = gx;
  }
  function stepLiquid(s, dt, w, H) {
    weather(s, dt);
    if (!isFinite(s.acc) || !isFinite(s.h[0]) || !isFinite(s.h[N >> 1]) || !isFinite(s.u[N >> 1])) { // never stay frozen
      s.h.fill(s.level || 0); s.u.fill(0); s.acc = 0; s.drops = []; s.foam.fill(0);
    }
    // Never let a slow frame make the next one heavier (that spiral is what lagged for a minute after opening
    // the app while the phone was still busy): at most 1/30 s of physics and 14 steps per frame, the rest is dropped.
    s.acc = Math.min(s.acc + dt, 1 / 30);
    let g = null, steps = 0; const rise = s.rise; rise.fill(0);
    // Step size follows the fastest wave (CFL): hard swings pile water up and speed waves up, and too big a
    // step is what turned the surface into a saw blade.
    let T = 0;
    while (s.acc >= SUB * 0.5 && steps < 14) {
      let hm = 0, um = 0;
      for (let i = 0; i < N; i++) if (s.h[i] > hm) hm = s.h[i];
      for (let j = 0; j <= N; j++) { const a = Math.abs(s.u[j]); if (a > um) um = a; }
      const c = Math.sqrt(G * hm) + um, dxs = w / N;
      const dts = Math.min(SUB, s.acc, (0.7 * dxs) / Math.max(1, c));
      s.acc -= dts; T += dts; g = physics(s, w, H, dts); steps++;
      for (let i = 0; i < N; i++) rise[i] += s.h[i] - s.prev[i];
    }
    if (steps >= 14) s.acc = 0;
    if (!g || T <= 0) return;
    const dx = g.dx, top = (i) => H - s.h[i];
    // spray where the surface shoots up fast, foam where the water is rough
    for (let i = 1; i < N - 1; i++) {
      const wv = rise[i] / T; // px/s upward
      const shear = Math.abs(s.u[i + 1] - s.u[i]);
      s.foam[i] = Math.min(1, s.foam[i] * Math.exp(-T * 0.9) + T * (Math.max(0, wv - 70) / 200 + shear / 900));
      if (wv > 150 && s.drops.length < 100 && Math.random() < Math.min(0.85, (wv - 150) / 320) * CS) {
        const n = 1 + (Math.random() * 3) | 0;
        const uu = (s.u[i] + s.u[i + 1]) / 2;
        for (let k = 0; k < n; k++) s.drops.push({ x: (i + Math.random()) * dx, y: top(i) - 1, vx: uu * 0.7 + (Math.random() - 0.5) * 90, vy: -(wv * (0.6 + Math.random() * 0.5)), r: 0.7 + Math.random() * 1.6 });
      }
    }
    // walls throw spray when water slams into them
    for (const [i, j] of [[0, 1], [N - 1, N - 1]]) {
      const hit = Math.abs(s.u[j]);
      if (hit > 250 && s.drops.length < 100 && Math.random() < 0.5) s.drops.push({ x: i ? w - 2 : 2, y: top(i) - 1, vx: (i ? -1 : 1) * Math.random() * 60, vy: -hit * (0.5 + Math.random() * 0.5), r: 0.8 + Math.random() * 1.5 });
    }
    s.drops = s.drops.filter((d) => {
      d.vx += g.gx * T; d.vy += g.gy * T; d.vx *= 1 - 0.6 * T; d.x += d.vx * T; d.y += d.vy * T;
      if (d.x < 1) { d.x = 1; d.vx = -d.vx * 0.4; } else if (d.x > w - 1) { d.x = w - 1; d.vx = -d.vx * 0.4; }
      const i = Math.max(0, Math.min(N - 1, (d.x / dx) | 0));
      if (d.vy > 0 && d.y >= top(i)) { s.foam[i] = Math.min(1, s.foam[i] + 0.25); return false; }
      return d.y < H + 4;
    });
    // Energy: how wild the liquid is right now (spray in the air, foam on top). Hard swings charge it up and
    // then spray and foam start arcing to each other like chain lightning.
    let foamSum = 0; for (let i = 0; i < N; i++) foamSum += s.foam[i];
    const e = Math.min(2, s.drops.length / 28 + (foamSum / N) * 5);
    s.energy = (s.energy || 0) + (e - (s.energy || 0)) * Math.min(1, T * 6);
    s.arcs = (s.arcs || []).filter((a) => a.until > lastT);
    if (s.energy > 0.55 && s.arcs.length < 3 && Math.random() < Math.min(0.55, (s.energy - 0.55) * 0.5)) {
      const nodes = s.drops.map((d) => [d.x, d.y]);
      for (let i = 0; i < N; i += 4) if (s.foam[i] > 0.35) nodes.push([(i + 0.5) * dx, top(i)]);
      if (nodes.length > 2) {
        let cur = nodes.splice((Math.random() * nodes.length) | 0, 1)[0];
        const pts = [cur];
        for (let hop = 0; hop < 7 && nodes.length; hop++) {
          let bi = -1, bd = 85 * 85;
          for (let k = 0; k < nodes.length; k++) { const ddx = nodes[k][0] - cur[0], ddy = nodes[k][1] - cur[1], d2 = ddx * ddx + ddy * ddy; if (d2 < bd && d2 > 36) { bd = d2; bi = k; } }
          if (bi < 0) break;
          cur = nodes.splice(bi, 1)[0]; pts.push(cur);
        }
        if (pts.length > 1) s.arcs.push({ pts, until: lastT + 90 + Math.random() * 120 });
      }
    }
    // small bubbles rising inside
    if (Math.random() < T * 1.6) s.bub.push({ x: Math.random() * w, y: H - 2, r: 0.8 + Math.random() * 1.8, vy: 16 + Math.random() * 22, wob: Math.random() * 6 });
    s.bub = s.bub.filter((b) => { b.y -= b.vy * T; b.wob += T * 4; const i = Math.max(0, Math.min(N - 1, (b.x / dx) | 0)); return b.y > top(i) + b.r; });
  }
  // Drawn surface = simulated surface + a slow ambient swell (three soft sines), so the liquid is never dead
  // still. Only where there is water; dry spots stay flat.
  function surfaceOf(s, H, t) {
    const y = s.surf || (s.surf = new Float32Array(N));
    const A = Math.min(3.2, s.level * 0.07);
    const h = s.h;
    for (let i = 0; i < N; i++) {
      // drawn from a soft average over 5 columns (weights 1 2 3 2 1), so a sudden wave never shows as a sharp tip
      let acc = 0, wsum = 0;
      for (let k = -2; k <= 2; k++) { const j = i + k; if (j < 0 || j >= N) continue; const wk = 3 - Math.abs(k); acc += h[j] * wk; wsum += wk; }
      const hh = acc / wsum, wet = Math.min(1, hh / 10), x = i * CS;
      const amb = Math.sin(x * 0.095 + t * 0.8) * 0.55 + Math.sin(x * 0.21 - t * 1.25) * 0.3 + Math.sin(x * 0.043 + t * 0.45 + 1.7) * 0.6;
      y[i] = H - hh - A * amb * wet;
    }
    return y;
  }
  // The surface as one smooth curve through the column points (curves through the midpoints), not a zigzag.
  function curve(ctx, y, dx, move) {
    const X = (i) => (i + 0.5) * dx;
    if (move) ctx.moveTo(X(0), y[0]); else ctx.lineTo(X(0), y[0]);
    for (let i = 1; i < N - 1; i++) ctx.quadraticCurveTo(X(i), y[i], (X(i) + X(i + 1)) / 2, (y[i] + y[i + 1]) / 2);
    ctx.lineTo(X(N - 1), y[N - 1]);
  }
  function liquidPath(ctx, y, w, H, dx) {
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, y[0]);
    curve(ctx, y, dx, false);
    ctx.lineTo(w, y[N - 1]); ctx.lineTo(w, H); ctx.closePath();
  }
  // soft round glows drawn once and stamped (making a gradient every frame is slow on phones)
  const glowCache = [];
  function glowSprite(k) {
    if (glowCache[k]) return glowCache[k];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), rg = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    const col = ['0, 200, 255', '90, 120, 255', '170, 90, 255'][k % 3];
    rg.addColorStop(0, `rgba(${col}, 0.14)`); rg.addColorStop(1, `rgba(${col}, 0)`);
    x.fillStyle = rg; x.fillRect(0, 0, 64, 64);
    return (glowCache[k] = c);
  }
  let orbCanvas = null;
  function orbSprite() { // one glowing orb drawn once, stamped for every drop
    if (orbCanvas) return orbCanvas;
    orbCanvas = document.createElement('canvas'); orbCanvas.width = orbCanvas.height = 32;
    const c = orbCanvas.getContext('2d'), rg = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    rg.addColorStop(0, 'rgba(235, 255, 255, 0.95)');
    rg.addColorStop(0.35, 'rgba(80, 200, 255, 0.55)');
    rg.addColorStop(1, 'rgba(40, 90, 255, 0)');
    c.fillStyle = rg; c.fillRect(0, 0, 32, 32);
    return orbCanvas;
  }
  function zig(ctx, x1, y1, x2, y2, spread) {
    const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 9));
    ctx.moveTo(x1, y1);
    for (let i = 1; i < n; i++) { const t = i / n; ctx.lineTo(x1 + (x2 - x1) * t + (Math.random() - 0.5) * spread, y1 + (y2 - y1) * t + (Math.random() - 0.5) * spread); }
    ctx.lineTo(x2, y2);
  }
  // Liquid energy: a dark deep body lit from inside by flowing plasma ribbons and drifting glows, a burning
  // surface line, glowing spray and arcs. Light layers are added (not painted over), so they glow where they meet.
  function drawLiquid(s, ctx, w, H) {
    const dx = w / N, t = lastT / 1000;
    const y = surfaceOf(s, H, t);
    let minTop = H;
    for (let i = 0; i < N; i++) if (y[i] < minTop) minTop = y[i];
    const E = Math.min(1.6, s.energy || 0), pulse = 0.85 + 0.15 * Math.sin(t * 2.3 + s.level);
    const hue = (k) => `${(188 + 40 * Math.sin(t * 0.35 + k)) | 0}`; // cyan to electric blue to violet
    // body
    const g = ctx.createLinearGradient(0, minTop, 0, H);
    g.addColorStop(0, `rgba(30, 150, 255, ${0.18 + 0.06 * E})`);
    g.addColorStop(0.5, 'rgba(25, 60, 200, 0.12)');
    g.addColorStop(1, 'rgba(40, 20, 140, 0.08)');
    liquidPath(ctx, y, w, H, dx);
    ctx.fillStyle = g; ctx.fill();
    ctx.save();
    liquidPath(ctx, y, w, H, dx);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    // drifting plasma glows
    for (let k = 0; k < (lite ? 1 : 3); k++) {
      const cx = w * (0.5 + 0.45 * Math.sin(t * (0.21 + k * 0.07) + k * 2)), cy = minTop + (H - minTop) * (0.45 + 0.3 * Math.sin(t * 0.3 + k));
      const r = Math.max(30, (H - minTop) * 0.9);
      ctx.globalAlpha = Math.min(1, 0.65 + 0.35 * E);
      ctx.drawImage(glowSprite(k), cx - r, cy - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }
    // flowing energy ribbons following the surface
    for (let k = 0; k < (lite ? 2 : 5); k++) {
      const off = 6 + k * 9, ph = t * (0.7 + k * 0.23) + k * 1.9, amp = 3 + k * 0.8;
      ctx.beginPath();
      for (let i = 0; i <= N; i += 4) {
        const j = Math.min(N - 1, i), X = (i + 0.5) * dx;
        const Y = y[j] + off + Math.sin(i * CS * 0.13 + ph) * amp + Math.sin(i * CS * 0.051 - ph * 0.7) * amp * 0.8;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      const a = (0.10 - k * 0.014) * pulse * (1 + 0.6 * E);
      ctx.strokeStyle = `hsla(${hue(k)}, 100%, 62%, ${a * 0.5})`; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = `hsla(${hue(k)}, 100%, 78%, ${a * 1.6})`; ctx.lineWidth = 1; ctx.stroke();
    }
    // glow just under the surface
    ctx.beginPath();
    curve(ctx, y, dx, true);
    ctx.strokeStyle = `rgba(80, 220, 255, ${0.10 * pulse + 0.05 * E})`; ctx.lineWidth = 16; ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // burning surface line: wide halo, colored core, white-hot center
    ctx.beginPath();
    curve(ctx, y, dx, true);
    ctx.strokeStyle = `hsla(${hue(0)}, 100%, 60%, ${0.10 + 0.08 * E})`; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = `hsla(${hue(0)}, 100%, 70%, ${0.35 * pulse + 0.15 * E})`; ctx.lineWidth = 2.4; ctx.stroke();
    ctx.strokeStyle = `rgba(230, 255, 255, ${0.55 * pulse})`; ctx.lineWidth = 0.9; ctx.stroke();
    // foam: hot sparks riding the surface
    // (grouped into 3 brightness levels: 3 draws instead of one per spark)
    for (let lv = 0; lv < 3; lv++) {
      const lo = [0.06, 0.35, 0.65][lv], hi = [0.35, 0.65, 2][lv];
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const f = s.foam[i];
        if (f < lo || f >= hi) continue;
        const seed = Math.sin(i * 12.9898 + ((lastT / 120) | 0) * 0.37) * 43758.5;
        const jx = seed - Math.floor(seed), jy = seed * 7.1 - Math.floor(seed * 7.1);
        const X = (i + jx) * dx, Y = y[i] + jy * 3 * f, R = 0.7 + f * 1.6;
        ctx.moveTo(X + R, Y); ctx.arc(X, Y, R, 0, 6.283);
      }
      ctx.fillStyle = `rgba(190, 250, 255, ${[0.3, 0.6, 0.9][lv]})`; ctx.fill();
    }
    // spray: small glowing orbs
    const orb = orbSprite();
    for (const d of s.drops) ctx.drawImage(orb, d.x - d.r * 3.5, d.y - d.r * 3.5, d.r * 7, d.r * 7);
    // chain lightning between spray and foam
    for (const a of s.arcs || []) {
      const life = Math.max(0, (a.until - lastT) / 200);
      ctx.beginPath();
      for (let k = 1; k < a.pts.length; k++) zig(ctx, a.pts[k - 1][0], a.pts[k - 1][1], a.pts[k][0], a.pts[k][1], 9);
      ctx.strokeStyle = `rgba(120, 200, 255, ${0.25 * life + 0.1})`; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = `rgba(160, 240, 255, ${0.6 * life + 0.25})`; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'; ctx.lineWidth = 0.8; ctx.stroke();
      for (const p of a.pts) { ctx.fillStyle = 'rgba(220, 250, 255, 0.9)'; ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, 6.283); ctx.fill(); }
    }
    // bubbles: faint rings
    for (const b of s.bub) {
      ctx.strokeStyle = 'rgba(150, 230, 255, 0.35)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(b.x + Math.sin(b.wob) * 1.5, b.y, b.r, 0, 6.283); ctx.stroke();
    }
    ctx.restore();
    // Coloured things in the card (red warnings, yellow, green...) tint the liquid around them: a soft glow of
    // their colour that only paints over the liquid that's already there.
    if (s.tints && s.tints.length) {
      ctx.save(); ctx.globalCompositeOperation = 'source-atop';
      const paint = (a0, a1) => { for (const c of s.tints) {
        const rg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        rg.addColorStop(0, `rgba(${c.rgb}, ${a0})`); rg.addColorStop(0.45, `rgba(${c.rgb}, ${a1})`); rg.addColorStop(1, `rgba(${c.rgb}, 0)`);
        ctx.fillStyle = rg; ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
      } };
      paint(1, 0.7); // recolour the liquid, glow and surface line included
    }
  }
  // Find the coloured elements of a card (text or backgrounds clearly not aqua/grey). Rechecked twice a second.
  function hueOf(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (d < 1e-6) return { h: 0, s: 0, l };
    const sat = d / (1 - Math.abs(2 * l - 1));
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return { h, s: sat, l };
  }
  const RGB = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/;
  function colourOf(str) {
    const m = RGB.exec(str || ''); if (!m) return null;
    if (m[4] !== undefined && +m[4] < 0.5) return null;
    const r = +m[1], g = +m[2], b = +m[3], c = hueOf(r, g, b);
    if (c.s < 0.45 || c.l < 0.25 || c.l > 0.85) return null; // grey, too dark, white
    if (c.h > 155 && c.h < 200) return null; // the aqua of the theme itself
    return `${r}, ${g}, ${b}`;
  }
  let tintBudget = 0;
  function refreshTints(card, s, now) {
    if (s.tintCard === card && now - (s.tintAt || 0) < 4000) return;
    if (tintBudget-- <= 0) return; // reading styles makes the browser recalculate: one card per frame at most
    s.tintCard = card; s.tintAt = now;
    const cr = card.getBoundingClientRect(), out = [];
    for (const el of card.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS' || el.tagName === 'svg' || el.closest('svg')) continue;
      const er = el.getBoundingClientRect();
      if (!er.width || !er.height || er.width > cr.width * 0.95) continue;
      const cs = getComputedStyle(el);
      let rgb = colourOf(cs.backgroundColor);
      if (!rgb) {
        let txt = false; for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { txt = true; break; }
        if (txt) rgb = colourOf(cs.color);
      }
      if (!rgb) continue;
      out.push({ rgb, x: er.left - cr.left + er.width / 2, y: er.top - cr.top + er.height / 2, r: 60 + Math.max(er.width, er.height) * 0.55 });
      if (out.length >= 8) break;
    }
    s.tints = out;
  }

  // ---- background bubbles and electric sparks between cards ----
  function stepBg(dt, w, h, ctx) {
    if (bubbles.length < 26 && Math.random() < dt * 5) bubbles.push({ x: Math.random() * w, y: h + 10, r: 2 + Math.random() * 7, vy: 25 + Math.random() * 45, wob: Math.random() * 6 });
    ctx.clearRect(0, 0, w, h);
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.y -= b.vy * dt; b.wob += dt * 2; b.x += (grav.x * 30 + Math.sin(b.wob) * 8) * dt;
      if (b.y < -20) { bubbles.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283);
      ctx.strokeStyle = 'rgba(90, 240, 230, 0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.25, 0, 6.283);
      ctx.fillStyle = 'rgba(200, 255, 250, 0.45)'; ctx.fill();
    }
  }
  function bolt(ctx, x1, y1, x2, y2, spread) {
    ctx.beginPath(); ctx.moveTo(x1, y1);
    const n = 9;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      ctx.lineTo(x1 + (x2 - x1) * t + (Math.random() - 0.5) * spread, y1 + (y2 - y1) * t + (Math.random() - 0.5) * spread);
    }
    ctx.lineTo(x2, y2); ctx.stroke();
  }
  function stepZap(now, w, h, ctx, cards) {
    ctx.clearRect(0, 0, w, h);
    if (!spark && now > sparkAt && cards.length) {
      const r = cards[Math.floor(Math.random() * cards.length)].getBoundingClientRect();
      const side = Math.random() < 0.5;
      const y = r.top + 12 + Math.random() * Math.max(10, r.height - 24);
      spark = { until: now + 140 + Math.random() * 120, x1: side ? r.left : r.right, y1: y, x2: side ? r.left + 6 + Math.random() * 30 : r.right - 6 - Math.random() * 30, y2: y + (Math.random() - 0.5) * 60 };
      sparkAt = now + 1200 + Math.random() * 2800;
    }
    if (spark) {
      if (now > spark.until) { spark = null; return; }
      ctx.save();
      ctx.shadowColor = 'rgba(120, 250, 255, 0.9)'; ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(210, 255, 255, 0.95)'; ctx.lineWidth = 1.6;
      bolt(ctx, spark.x1, spark.y1, spark.x2, spark.y2, 14);
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.6)'; ctx.lineWidth = 1;
      bolt(ctx, spark.x1, spark.y1, spark.x2 + 10, spark.y2 - 8, 18);
      ctx.restore();
    }
  }

  function frame(now) {
    raf = 0;
    if (!on) return;
    if (document.hidden) { lastT = 0; raf = requestAnimationFrame(frame); return; }
    // 60 frames a second, steady: on 90/120 Hz screens every other screen refresh is skipped, so each frame has
    // twice the time and the motion stays even instead of stuttering.
    if (lastT && now - lastT < 1000 / 64) { raf = requestAnimationFrame(frame); return; }
    tintBudget = 1;
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
    // Busy phone (just opened, still loading): draw a lighter liquid until frames are quick again.
    frameAvg += (dt * 1000 - frameAvg) * 0.1;
    lite = lite ? frameAvg > 19 : frameAvg > 24;
    lastT = now;
    const vh = root.innerHeight;
    for (const [card, s] of sims) if (!card.isConnected) { s.canvas.remove(); sims.delete(card); }
    // only cards whose lower part (where the liquid is) is on screen
    const cards = Array.from(document.querySelectorAll('.view:not([hidden]) .card, .sheet:not([hidden]) .card')).filter((c) => {
      const r = c.getBoundingClientRect(); return r.bottom > 0 && r.bottom - Math.min(r.height, 160) < vh && r.width > 0;
    });
    for (const card of cards) {
      const s = simFor(card);
      const w = card.clientWidth, h = card.clientHeight;
      if (!w || !h) continue;
      // The canvas only covers the bottom of the card, where the liquid can reach: far fewer pixels to draw.
      const lvl = Math.min(Math.max(h * 0.26, 22), 80), regionH = Math.min(h, Math.round(lvl * 3.4 + 40));
      if (s.regionH !== regionH) { s.canvas.style.height = regionH + 'px'; s.regionH = regionH; }
      const { r } = fit(s.canvas);
      stepLiquid(s, dt, w, h);
      refreshTints(card, s, now);
      const ctx = s.ctx || (s.ctx = s.canvas.getContext('2d', { desynchronized: true }));
      ctx.setTransform(r, 0, 0, r, 0, -(h - regionH) * r); ctx.clearRect(0, h - regionH, w, regionH);
      drawLiquid(s, ctx, w, h);
    }
    { const { w, h, r } = fit(bg); const ctx = bg.getContext('2d', { desynchronized: true }); ctx.setTransform(r, 0, 0, r, 0, 0); stepBg(dt, w, h, ctx); }
    // the spark layer covers the whole screen: only touch it when a spark is (or just was) on it
    if (spark || now > sparkAt || zapDirty) {
      const { w, h, r } = fit(zap); const ctx = zap.getContext('2d', { desynchronized: true }); ctx.setTransform(r, 0, 0, r, 0, 0);
      stepZap(now, w, h, ctx, cards); zapDirty = !!spark;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    document.body.classList.add('catchup');
    if (on) return;
    on = true;
    bg = bg || layer('fxBg', 0);
    zap = zap || layer('fxZap', 40);
    lastT = 0; raf = requestAnimationFrame(frame);
  }
  function stop() {
    document.body.classList.remove('catchup');
    on = false;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    for (const s of sims.values()) s.canvas.remove();
    sims.clear(); bubbles.length = 0; spark = null;
    if (bg) { bg.remove(); bg = null; }
    if (zap) { zap.remove(); zap = null; }
  }

  root.CatchupFX = { start, stop, askMotion, isOn: () => on, _sims: sims };
})(window);
