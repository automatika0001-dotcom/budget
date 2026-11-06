/* Catch-up mode look: aqua colours, bubbles and sparks, and blue liquid in every card that sloshes with the
   phone's tilt (gyroscope). One animation loop for everything; it sleeps while the app is hidden. */
(function (root) {
  'use strict';
  let on = false, raf = 0, bg = null, zap = null, lastT = 0;
  // gravity on screen (x: right, y: down), smoothed; jolt = sideways shake from the accelerometer
  const tilt = { gx: 0, gy: 1, tx: 0, ty: 1, jolt: 0, live: false };
  const sims = new Map(); // card -> liquid state
  const bubbles = []; // background bubbles
  let sparkAt = 0, spark = null;
  const DPR = () => Math.min(2, root.devicePixelRatio || 1);

  function onOrient(e) {
    if (e.gamma === null || e.beta === null) return;
    tilt.live = true;
    const g = (e.gamma || 0) * Math.PI / 180, b = (e.beta || 0) * Math.PI / 180;
    // screen orientation: turn the vector when the phone is held sideways
    const ang = ((screen.orientation && screen.orientation.angle) || root.orientation || 0) * Math.PI / 180;
    let x = Math.sin(g) * Math.cos(b), y = Math.sin(b);
    if (y < 0.15 && Math.abs(x) < 0.3) y = 0.15; // lying flat or upside down: liquid still settles to the bottom
    const c = Math.cos(-ang), s = Math.sin(-ang);
    tilt.tx = x * c - y * s; tilt.ty = x * s + y * c;
  }
  function onMotion(e) {
    const a = e.acceleration || {};
    if (typeof a.x === 'number') tilt.jolt += Math.max(-6, Math.min(6, a.x)) * 0.5;
  }

  /** iOS needs a tap before it shares the gyroscope. Call from the switch's click. */
  function askMotion() {
    try {
      const O = root.DeviceOrientationEvent, M = root.DeviceMotionEvent;
      if (O && typeof O.requestPermission === 'function') O.requestPermission().catch(() => {});
      if (M && typeof M.requestPermission === 'function') M.requestPermission().catch(() => {});
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

  // ---- liquid in a card: a row of water columns (height field) pulled toward the tilted surface ----
  function simFor(card) {
    let s = sims.get(card);
    if (s && s.canvas.isConnected) return s;
    const canvas = document.createElement('canvas');
    canvas.className = 'liquid';
    card.prepend(canvas);
    const N = 28;
    s = { canvas, N, h: new Float32Array(N).fill(0), v: new Float32Array(N), bub: [], phase: Math.random() * 6 };
    sims.set(card, s);
    return s;
  }
  function stepSim(s, dt, w, h) {
    const N = s.N, level = Math.min(Math.max(h * 0.3, 26), 90);
    // surface slope from tilt: liquid piles up on the low side
    const slope = Math.max(-1.4, Math.min(1.4, tilt.gx / Math.max(0.25, Math.abs(tilt.gy) + 0.25)));
    const idle = tilt.live ? 0 : Math.sin(lastT / 1400 + s.phase) * 0.18;
    const k = 30, c = 140, damp = 2.2;
    const jolt = tilt.jolt;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1) - 0.5) * w;
      const target = (slope + idle) * x * 0.55;
      const left = s.h[i > 0 ? i - 1 : i], right = s.h[i < N - 1 ? i + 1 : i];
      let a = k * (target - s.h[i]) + c * (left + right - 2 * s.h[i]) - damp * s.v[i];
      a += jolt * (i / (N - 1) - 0.5) * 40;
      s.v[i] += a * dt;
    }
    // keep the amount of liquid the same
    let mean = 0;
    for (let i = 0; i < N; i++) { s.h[i] += s.v[i] * dt; mean += s.h[i]; }
    mean /= N;
    for (let i = 0; i < N; i++) s.h[i] = Math.max(-level * 0.95, Math.min(h - level - 4, s.h[i] - mean));
    s.level = level;
    // bubbles rising inside the liquid
    if (Math.random() < dt * 2.2) s.bub.push({ x: Math.random() * w, y: h - 2, r: 1 + Math.random() * 2.6, vy: 18 + Math.random() * 26, wob: Math.random() * 6 });
    s.bub = s.bub.filter((b) => {
      b.y -= b.vy * dt; b.wob += dt * 4;
      const i = Math.max(0, Math.min(N - 1, Math.round((b.x / w) * (N - 1))));
      return b.y > h - level - s.h[i] + b.r;
    });
  }
  function drawSim(s, ctx, w, h) {
    const N = s.N, level = s.level, top = h - level;
    const g = ctx.createLinearGradient(0, top - 40, 0, h);
    g.addColorStop(0, 'rgba(70, 225, 255, 0.42)');
    g.addColorStop(0.5, 'rgba(30, 120, 255, 0.34)');
    g.addColorStop(1, 'rgba(10, 40, 160, 0.48)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < N; i++) ctx.lineTo((i / (N - 1)) * w, top - s.h[i]);
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    // bright surface line
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const X = (i / (N - 1)) * w, Y = top - s.h[i]; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
    ctx.strokeStyle = 'rgba(160, 250, 255, 0.75)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = 'rgba(200, 250, 255, 0.55)';
    for (const b of s.bub) { ctx.beginPath(); ctx.arc(b.x + Math.sin(b.wob) * 2, b.y, b.r, 0, 6.283); ctx.fill(); }
  }

  // ---- background bubbles and electric sparks between cards ----
  function stepBg(dt, w, h, ctx) {
    if (bubbles.length < 26 && Math.random() < dt * 5) bubbles.push({ x: Math.random() * w, y: h + 10, r: 2 + Math.random() * 7, vy: 25 + Math.random() * 45, wob: Math.random() * 6 });
    ctx.clearRect(0, 0, w, h);
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.y -= b.vy * dt; b.wob += dt * 2; b.x += (tilt.gx * 30 + Math.sin(b.wob) * 8) * dt;
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
    if (document.hidden) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.033, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;
    tilt.gx += (tilt.tx - tilt.gx) * Math.min(1, dt * 6);
    tilt.gy += (tilt.ty - tilt.gy) * Math.min(1, dt * 6);
    const vh = root.innerHeight;
    const cards = Array.from(document.querySelectorAll('.view:not([hidden]) .card, .sheet:not([hidden]) .card')).filter((c) => {
      const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.width > 0;
    });
    for (const [card, s] of sims) if (!card.isConnected) { s.canvas.remove(); sims.delete(card); }
    for (const card of cards) {
      const s = simFor(card);
      const { w, h, r } = fit(s.canvas);
      if (!w || !h) continue;
      stepSim(s, dt, w, h);
      const ctx = s.canvas.getContext('2d');
      ctx.setTransform(r, 0, 0, r, 0, 0); ctx.clearRect(0, 0, w, h);
      drawSim(s, ctx, w, h);
    }
    tilt.jolt *= Math.pow(0.02, dt);
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
    root.addEventListener('deviceorientation', onOrient);
    root.addEventListener('devicemotion', onMotion);
    lastT = 0; raf = requestAnimationFrame(frame);
  }
  function stop() {
    document.body.classList.remove('catchup');
    on = false;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    root.removeEventListener('deviceorientation', onOrient);
    root.removeEventListener('devicemotion', onMotion);
    for (const s of sims.values()) s.canvas.remove();
    sims.clear(); bubbles.length = 0; spark = null;
    if (bg) { bg.remove(); bg = null; }
    if (zap) { zap.remove(); zap = null; }
  }

  root.CatchupFX = { start, stop, askMotion, isOn: () => on };
})(window);
