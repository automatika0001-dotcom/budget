/* Catch-up mode look: aqua colours, bubbles and sparks, and blue liquid in every card that sloshes with the
   phone's movement. The liquid is a shallow-water simulation (120 columns per card) driven by the phone's
   accelerometer with no smoothing, so tilts and shakes act at once; fast waves throw spray and leave foam.
   One animation loop for everything; it sleeps while the app is hidden. */
(function (root) {
  'use strict';
  let on = false, raf = 0, bg = null, zap = null, lastT = 0;
  // apparent gravity on the screen in units of g (x: right, y: down). Includes shakes: moving the phone right
  // pushes the liquid left, like a real glass.
  const grav = { x: 0, y: 1, live: false, src: '' };
  const sims = new Map(); // card -> liquid state
  const bubbles = []; // background bubbles
  let sparkAt = 0, spark = null;
  const DPR = () => Math.min(2, root.devicePixelRatio || 1);
  const screenAngle = () => (((screen.orientation && screen.orientation.angle) || root.orientation || 0) * Math.PI) / 180;
  function toScreen(x, y) {
    const a = screenAngle(), c = Math.cos(a), s = Math.sin(a);
    grav.x = x * c - y * s; grav.y = x * s + y * c; grav.live = true;
  }
  // Android reports the sensor's push against gravity, older iPhones the gravity itself: the tilt from the
  // orientation sensor tells which, so the liquid never falls the wrong way.
  let flipVotes = 0, orientY = null;
  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || typeof a.x !== 'number' || a.x === null) return;
    grav.src = 'motion';
    let x = -a.x / 9.81, y = a.y / 9.81;
    if (orientY !== null && Math.abs(orientY) > 0.4 && Math.abs(y) > 0.4) flipVotes = Math.max(-20, Math.min(20, flipVotes + (Math.sign(orientY) !== Math.sign(y) ? 1 : -1)));
    if (flipVotes > 0) { x = -x; y = -y; }
    toScreen(x, y);
  }
  function onOrient(e) {
    if (e.gamma === null || e.beta === null) return;
    const g = ((e.gamma || 0) * Math.PI) / 180, b = ((e.beta || 0) * Math.PI) / 180;
    orientY = Math.sin(b);
    if (grav.src !== 'motion') toScreen(Math.sin(g) * Math.cos(b), Math.sin(b));
  }

  /** iOS needs a tap before it shares motion data. Call from the switch's click. */
  function askMotion() {
    try {
      const O = root.DeviceOrientationEvent, M = root.DeviceMotionEvent;
      if (M && typeof M.requestPermission === 'function') M.requestPermission().catch(() => {});
      if (O && typeof O.requestPermission === 'function') O.requestPermission().catch(() => {});
    } catch (e) { /* not available */ }
  }

  function layer(id, z) {
    const c = document.createElement('canvas');
    c.id = id; c.className = 'fx-layer'; c.style.zIndex = z;
    document.body.appendChild(c);
    return c;
  }
  function fit(c) {
    const r = DPR(), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
    return { w, h, r };
  }

  // ---- liquid: 1D shallow water. h = depth per column, u = speed across each column boundary ----
  const N = 120, G = 3600, SUB = 1 / 240; // columns, px/s² for 1 g, physics step
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
  function physics(s, w, H) {
    const level = Math.min(Math.max(H * 0.26, 22), 80);
    if (s.level !== level || s.w !== w) { // new or resized card: refill to the level, keep the motion
      const mass = s.level ? s.h.reduce((a, b) => a + b, 0) : 0;
      if (!mass) s.h.fill(level); else { const k = (level * N) / mass; for (let i = 0; i < N; i++) s.h[i] *= k; }
      s.level = level; s.w = w;
    }
    const dx = w / N, h = s.h, u = s.u;
    // flat phone: keep some "down" so the liquid still settles
    const gx = Math.max(-1.6, Math.min(1.6, grav.x)) * G, gy = Math.max(0.3, Math.min(2, grav.y)) * G;
    const vmax = (0.45 * dx) / SUB;
    s.prev.set(h);
    for (let j = 1; j < N; j++) {
      let v = u[j] + SUB * (gx - (gy * (h[j] - h[j - 1])) / dx);
      v += 0.18 * (u[j - 1] + u[j + 1] - 2 * u[j]); // a little viscosity
      v *= 1 - 0.9 * SUB; // friction
      if (h[j] + h[j - 1] < 0.5) v = 0;
      u[j] = v > vmax ? vmax : v < -vmax ? -vmax : v;
    }
    u[0] = 0; u[N] = 0;
    // move the water (upwind), never below empty
    const out = s.out; out[0] = 0; out[N] = 0;
    for (let j = 1; j < N; j++) out[j] = u[j] * (u[j] > 0 ? h[j - 1] : h[j]) * (SUB / dx);
    for (let i = 0; i < N; i++) {
      const give = Math.max(0, out[i + 1]) + Math.max(0, -out[i]);
      if (give > h[i] && give > 0) { const k = h[i] / give; if (out[i + 1] > 0) out[i + 1] *= k; if (out[i] < 0) out[i] *= k; }
    }
    for (let i = 0; i < N; i++) h[i] = Math.max(0, h[i] - out[i + 1] + out[i]);
    return { gx, gy, dx };
  }
  function stepLiquid(s, dt, w, H) {
    s.acc = Math.min(s.acc + dt, 0.05);
    let g = null, steps = 0; const rise = s.rise; rise.fill(0);
    while (s.acc >= SUB) {
      s.acc -= SUB; g = physics(s, w, H); steps++;
      for (let i = 0; i < N; i++) rise[i] += s.h[i] - s.prev[i];
    }
    if (!g) return;
    const T = steps * SUB, dx = g.dx, top = (i) => H - s.h[i];
    // spray where the surface shoots up fast, foam where the water is rough
    for (let i = 1; i < N - 1; i++) {
      const wv = rise[i] / T; // px/s upward
      const shear = Math.abs(s.u[i + 1] - s.u[i]);
      s.foam[i] = Math.min(1, s.foam[i] * Math.exp(-T * 0.9) + T * (Math.max(0, wv - 60) / 220 + shear / 900));
      if (wv > 140 && s.drops.length < 160 && Math.random() < Math.min(0.9, (wv - 140) / 300)) {
        const n = 1 + (Math.random() * 3) | 0;
        const uu = (s.u[i] + s.u[i + 1]) / 2;
        for (let k = 0; k < n; k++) s.drops.push({ x: (i + Math.random()) * dx, y: top(i) - 1, vx: uu * 0.7 + (Math.random() - 0.5) * 90, vy: -(wv * (0.7 + Math.random() * 0.6)), r: 0.7 + Math.random() * 1.6 });
      }
    }
    // walls throw spray when water slams into them
    for (const [i, j] of [[0, 1], [N - 1, N - 1]]) {
      const hit = Math.abs(s.u[j]);
      if (hit > 220 && s.drops.length < 160 && Math.random() < 0.5) s.drops.push({ x: i ? w - 2 : 2, y: top(i) - 1, vx: (i ? -1 : 1) * Math.random() * 60, vy: -hit * (0.5 + Math.random() * 0.5), r: 0.8 + Math.random() * 1.5 });
    }
    s.drops = s.drops.filter((d) => {
      d.vx += g.gx * T; d.vy += g.gy * T; d.vx *= 1 - 0.6 * T; d.x += d.vx * T; d.y += d.vy * T;
      if (d.x < 1) { d.x = 1; d.vx = -d.vx * 0.4; } else if (d.x > w - 1) { d.x = w - 1; d.vx = -d.vx * 0.4; }
      const i = Math.max(0, Math.min(N - 1, (d.x / dx) | 0));
      if (d.vy > 0 && d.y >= top(i)) { s.foam[i] = Math.min(1, s.foam[i] + 0.25); return false; }
      return d.y < H + 4;
    });
    // small bubbles rising inside
    if (Math.random() < T * 1.6) s.bub.push({ x: Math.random() * w, y: H - 2, r: 0.8 + Math.random() * 1.8, vy: 16 + Math.random() * 22, wob: Math.random() * 6 });
    s.bub = s.bub.filter((b) => { b.y -= b.vy * T; b.wob += T * 4; const i = Math.max(0, Math.min(N - 1, (b.x / dx) | 0)); return b.y > top(i) + b.r; });
  }
  function drawLiquid(s, ctx, w, H) {
    const dx = w / N;
    let minTop = H;
    for (let i = 0; i < N; i++) minTop = Math.min(minTop, H - s.h[i]);
    // subtle: light at the surface, fading out toward the bottom of the card
    const g = ctx.createLinearGradient(0, minTop, 0, H);
    g.addColorStop(0, 'rgba(90, 225, 255, 0.26)');
    g.addColorStop(0.35, 'rgba(40, 140, 255, 0.14)');
    g.addColorStop(1, 'rgba(20, 60, 200, 0.05)');
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H - s.h[0]);
    for (let i = 0; i < N; i++) ctx.lineTo((i + 0.5) * dx, H - s.h[i]);
    ctx.lineTo(w, H - s.h[N - 1]);
    ctx.lineTo(w, H); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    // thin surface line, whiter and thicker where it foams
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const X = (i + 0.5) * dx, Y = H - s.h[i]; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
    ctx.strokeStyle = 'rgba(160, 245, 255, 0.4)'; ctx.lineWidth = 1; ctx.stroke();
    for (let i = 0; i < N - 1; i++) {
      const f = Math.max(s.foam[i], s.foam[i + 1]);
      if (f < 0.08) continue;
      ctx.strokeStyle = `rgba(240, 255, 255, ${0.6 * f})`; ctx.lineWidth = 1 + f * 1.5;
      ctx.beginPath(); ctx.moveTo((i + 0.5) * dx, H - s.h[i]); ctx.lineTo((i + 1.5) * dx, H - s.h[i + 1]); ctx.stroke();
    }
    // foam specks just under the surface
    for (let i = 0; i < N; i++) {
      const f = s.foam[i];
      if (f < 0.06) continue;
      const seed = Math.sin(i * 12.9898 + ((lastT / 260) | 0) * 0.37) * 43758.5;
      const jx = seed - Math.floor(seed), jy = (seed * 7.1) - Math.floor(seed * 7.1);
      ctx.fillStyle = `rgba(235, 255, 255, ${Math.min(0.8, f)})`;
      ctx.beginPath(); ctx.arc((i + jx) * dx, H - s.h[i] + 1 + jy * 4 * f, 0.6 + f * 1.4, 0, 6.283); ctx.fill();
    }
    ctx.fillStyle = 'rgba(210, 250, 255, 0.75)';
    for (const d of s.drops) { ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.283); ctx.fill(); }
    ctx.fillStyle = 'rgba(200, 245, 255, 0.35)';
    for (const b of s.bub) { ctx.beginPath(); ctx.arc(b.x + Math.sin(b.wob) * 1.5, b.y, b.r, 0, 6.283); ctx.fill(); }
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
    const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    if (!grav.live) { grav.x = Math.sin(now / 1500) * 0.25; grav.y = 1; } // no sensor (computer): a gentle sway
    const vh = root.innerHeight;
    for (const [card, s] of sims) if (!card.isConnected) { s.canvas.remove(); sims.delete(card); }
    const cards = Array.from(document.querySelectorAll('.view:not([hidden]) .card, .sheet:not([hidden]) .card')).filter((c) => {
      const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.width > 0;
    });
    for (const card of cards) {
      const s = simFor(card);
      const { w, h, r } = fit(s.canvas);
      if (!w || !h) continue;
      stepLiquid(s, dt, w, h);
      const ctx = s.canvas.getContext('2d');
      ctx.setTransform(r, 0, 0, r, 0, 0); ctx.clearRect(0, 0, w, h);
      drawLiquid(s, ctx, w, h);
    }
    { const { w, h, r } = fit(bg); const ctx = bg.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); stepBg(dt, w, h, ctx); }
    { const { w, h, r } = fit(zap); const ctx = zap.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); stepZap(now, w, h, ctx, cards); }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    document.body.classList.add('catchup');
    if (on) return;
    on = true;
    bg = bg || layer('fxBg', 0);
    zap = zap || layer('fxZap', 40);
    root.addEventListener('devicemotion', onMotion);
    root.addEventListener('deviceorientation', onOrient);
    lastT = 0; raf = requestAnimationFrame(frame);
  }
  function stop() {
    document.body.classList.remove('catchup');
    on = false;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    root.removeEventListener('devicemotion', onMotion);
    root.removeEventListener('deviceorientation', onOrient);
    for (const s of sims.values()) s.canvas.remove();
    sims.clear(); bubbles.length = 0; spark = null;
    if (bg) { bg.remove(); bg = null; }
    if (zap) { zap.remove(); zap = null; }
  }

  root.CatchupFX = { start, stop, askMotion, isOn: () => on, _grav: grav, _sims: sims };
})(window);
