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
  // Heavy liquid: the slow part of the signal (how the phone is tilted) counts almost fully, quick jolts only
  // partly, so it leans with the phone right away but doesn't jump at every twitch.
  const slow = { x: 0, y: 1, t: 0 };
  function toScreen(x, y) {
    const a = screenAngle(), c = Math.cos(a), s = Math.sin(a);
    const X = x * c - y * s, Y = x * s + y * c;
    const now = performance.now(), dt = slow.t ? Math.min(0.1, (now - slow.t) / 1000) : 1; slow.t = now;
    const k = Math.min(1, dt / 0.12);
    slow.x += (X - slow.x) * k; slow.y += (Y - slow.y) * k;
    grav.x = slow.x * 0.8 + (X - slow.x) * 0.35; grav.y = slow.y + (Y - slow.y) * 0.35; grav.live = true;
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
  function physics(s, w, H, dts) {
    const level = Math.min(Math.max(H * 0.26, 22), 80);
    if (s.level !== level || s.w !== w) { // new or resized card: refill to the level, keep the motion
      const mass = s.level ? s.h.reduce((a, b) => a + b, 0) : 0;
      if (!mass) s.h.fill(level); else { const k = (level * N) / mass; for (let i = 0; i < N; i++) s.h[i] *= k; }
      s.level = level; s.w = w;
    }
    const dx = w / N, h = s.h, u = s.u;
    // flat phone: keep some "down" so the liquid still settles
    const gx = Math.max(-1.2, Math.min(1.2, grav.x)) * G, gy = Math.max(0.3, Math.min(1.5, grav.y)) * G;
    const vmax = (0.45 * dx) / dts, q = dts / SUB;
    s.prev.set(h);
    for (let j = 1; j < N; j++) {
      let v = u[j] + dts * (gx - (gy * (h[j] - h[j - 1])) / dx);
      v += Math.min(0.45, 0.26 * q) * (u[j - 1] + u[j + 1] - 2 * u[j]); // viscosity: thick, heavy liquid
      v *= 1 - 1.8 * dts; // friction
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
    // a column can't tower over the card: what's above the cap spills to its neighbours
    const cap = Math.min(H - 6, s.level * 3.2);
    for (let i = 0; i < N; i++) if (h[i] > cap) {
      const ex = h[i] - cap; h[i] = cap;
      if (i === 0) h[1] += ex; else if (i === N - 1) h[N - 2] += ex; else { h[i - 1] += ex / 2; h[i + 1] += ex / 2; }
    }
    return { gx, gy, dx };
  }
  function stepLiquid(s, dt, w, H) {
    s.acc = Math.min(s.acc + dt, 0.05);
    let g = null, steps = 0; const rise = s.rise; rise.fill(0);
    // Step size follows the fastest wave (CFL): hard swings pile water up and speed waves up, and too big a
    // step is what turned the surface into a saw blade.
    let T = 0;
    while (s.acc >= SUB * 0.5 && steps < 48) {
      let hm = 0, um = 0;
      for (let i = 0; i < N; i++) if (s.h[i] > hm) hm = s.h[i];
      for (let j = 0; j <= N; j++) { const a = Math.abs(s.u[j]); if (a > um) um = a; }
      const c = Math.sqrt(1.5 * G * hm) + um, dxs = w / N;
      const dts = Math.min(SUB, s.acc, (0.35 * dxs) / Math.max(1, c));
      s.acc -= dts; T += dts; g = physics(s, w, H, dts); steps++;
      for (let i = 0; i < N; i++) rise[i] += s.h[i] - s.prev[i];
    }
    if (steps >= 48) s.acc = 0;
    if (!g || T <= 0) return;
    const dx = g.dx, top = (i) => H - s.h[i];
    // spray where the surface shoots up fast, foam where the water is rough
    for (let i = 1; i < N - 1; i++) {
      const wv = rise[i] / T; // px/s upward
      const shear = Math.abs(s.u[i + 1] - s.u[i]);
      s.foam[i] = Math.min(1, s.foam[i] * Math.exp(-T * 0.9) + T * (Math.max(0, wv - 110) / 260 + shear / 1300));
      if (wv > 240 && s.drops.length < 120 && Math.random() < Math.min(0.6, (wv - 240) / 450)) {
        const n = 1 + (Math.random() * 3) | 0;
        const uu = (s.u[i] + s.u[i + 1]) / 2;
        for (let k = 0; k < n; k++) s.drops.push({ x: (i + Math.random()) * dx, y: top(i) - 1, vx: uu * 0.7 + (Math.random() - 0.5) * 90, vy: -(wv * (0.5 + Math.random() * 0.4)), r: 0.7 + Math.random() * 1.6 });
      }
    }
    // walls throw spray when water slams into them
    for (const [i, j] of [[0, 1], [N - 1, N - 1]]) {
      const hit = Math.abs(s.u[j]);
      if (hit > 380 && s.drops.length < 120 && Math.random() < 0.35) s.drops.push({ x: i ? w - 2 : 2, y: top(i) - 1, vx: (i ? -1 : 1) * Math.random() * 60, vy: -hit * (0.5 + Math.random() * 0.5), r: 0.8 + Math.random() * 1.5 });
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
      for (let i = 0; i < N; i += 2) if (s.foam[i] > 0.35) nodes.push([(i + 0.5) * dx, top(i)]);
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
    for (let i = 0; i < N; i++) {
      const wet = Math.min(1, s.h[i] / 10);
      const amb = Math.sin(i * 0.095 + t * 0.8) * 0.55 + Math.sin(i * 0.21 - t * 1.25) * 0.3 + Math.sin(i * 0.043 + t * 0.45 + 1.7) * 0.6;
      y[i] = H - s.h[i] - A * amb * wet;
    }
    return y;
  }
  function liquidPath(ctx, y, w, H, dx) {
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, y[0]);
    for (let i = 0; i < N; i++) ctx.lineTo((i + 0.5) * dx, y[i]);
    ctx.lineTo(w, y[N - 1]); ctx.lineTo(w, H); ctx.closePath();
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
    for (let k = 0; k < 3; k++) {
      const cx = w * (0.5 + 0.45 * Math.sin(t * (0.21 + k * 0.07) + k * 2)), cy = minTop + (H - minTop) * (0.45 + 0.3 * Math.sin(t * 0.3 + k));
      const r = Math.max(30, (H - minTop) * 0.9);
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, `hsla(${hue(k * 2)}, 100%, 60%, ${0.10 + 0.05 * E})`);
      rg.addColorStop(1, 'hsla(220, 100%, 50%, 0)');
      ctx.fillStyle = rg; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    // flowing energy ribbons following the surface
    for (let k = 0; k < 5; k++) {
      const off = 6 + k * 9, ph = t * (0.7 + k * 0.23) + k * 1.9, amp = 3 + k * 0.8;
      ctx.beginPath();
      for (let i = 0; i <= N; i += 2) {
        const j = Math.min(N - 1, i), X = (i + 0.5) * dx;
        const Y = y[j] + off + Math.sin(i * 0.13 + ph) * amp + Math.sin(i * 0.051 - ph * 0.7) * amp * 0.8;
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      }
      const a = (0.10 - k * 0.014) * pulse * (1 + 0.6 * E);
      ctx.strokeStyle = `hsla(${hue(k)}, 100%, 62%, ${a * 0.5})`; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = `hsla(${hue(k)}, 100%, 78%, ${a * 1.6})`; ctx.lineWidth = 1; ctx.stroke();
    }
    // glow just under the surface
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const X = (i + 0.5) * dx; i ? ctx.lineTo(X, y[i]) : ctx.moveTo(X, y[i]); }
    ctx.strokeStyle = `rgba(80, 220, 255, ${0.10 * pulse + 0.05 * E})`; ctx.lineWidth = 16; ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // burning surface line: wide halo, colored core, white-hot center
    ctx.beginPath();
    for (let i = 0; i < N; i++) { const X = (i + 0.5) * dx; i ? ctx.lineTo(X, y[i]) : ctx.moveTo(X, y[i]); }
    ctx.strokeStyle = `hsla(${hue(0)}, 100%, 60%, ${0.10 + 0.08 * E})`; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = `hsla(${hue(0)}, 100%, 70%, ${0.35 * pulse + 0.15 * E})`; ctx.lineWidth = 2.4; ctx.stroke();
    ctx.strokeStyle = `rgba(230, 255, 255, ${0.55 * pulse})`; ctx.lineWidth = 0.9; ctx.stroke();
    // foam: hot sparks riding the surface
    for (let i = 0; i < N; i++) {
      const f = s.foam[i];
      if (f < 0.06) continue;
      const seed = Math.sin(i * 12.9898 + ((lastT / 120) | 0) * 0.37) * 43758.5;
      const jx = seed - Math.floor(seed), jy = seed * 7.1 - Math.floor(seed * 7.1);
      ctx.fillStyle = `rgba(190, 250, 255, ${Math.min(0.9, f)})`;
      ctx.beginPath(); ctx.arc((i + jx) * dx, y[i] + jy * 3 * f, 0.7 + f * 1.6, 0, 6.283); ctx.fill();
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
