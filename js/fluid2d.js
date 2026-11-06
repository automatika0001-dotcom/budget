/* A small 2D particle fluid (double density relaxation, Clavet et al. 2005). Positions in px, one step = 1/120 s.
   Pure: no DOM, so it's tested in node. Used by catchup-fx.js for the liquid in every card. */
(function (root) {
  'use strict';
  const P = {
    s: 7, // particle spacing at rest, px
    h: 16, // interaction radius, px
    rho0: 3.2, // rest density
    k: 0.35, // pressure stiffness
    kNear: 0.9, // near pressure (keeps particles apart, gives surface tension-like clumping)
    sigma: 0.08, beta: 0.12, // viscosity (linear, quadratic)
    g: 0.25, // 1 g in px/step²
    bounce: 0.3,
    maxV: 9 // px/step cap for stability
  };
  function create(w, H, fill, opt) {
    const p = Object.assign({}, P, opt || {});
    const level = Math.min(Math.max(H * fill, 22), 90);
    const cols = Math.max(2, Math.floor((w - p.s) / p.s)), rows = Math.max(1, Math.floor(level / (p.s * 0.95)));
    let n = Math.min(cols * rows, p.max || 420);
    const f = { p, w, H, n, x: new Float32Array(n), y: new Float32Array(n), px: new Float32Array(n), py: new Float32Array(n),
      vx: new Float32Array(n), vy: new Float32Array(n), rho: new Float32Array(n), spd: new Float32Array(n),
      cell: null, next: new Int32Array(n), gw: 0, gh: 0, t: 0 };
    let i = 0;
    for (let r = 0; r < rows && i < n; r++) for (let c = 0; c < cols && i < n; c++, i++) {
      f.x[i] = p.s * 0.75 + c * p.s + (r % 2) * p.s * 0.5 + Math.random() * 0.3;
      f.y[i] = H - p.s * 0.6 - r * p.s * 0.95;
    }
    return f;
  }
  function grid(f) {
    const h = f.p.h, gw = Math.ceil(f.w / h) + 1, gh = Math.ceil(f.H / h) + 1;
    if (!f.cell || f.gw !== gw || f.gh !== gh) { f.cell = new Int32Array(gw * gh); f.gw = gw; f.gh = gh; }
    f.cell.fill(-1);
    for (let i = 0; i < f.n; i++) {
      const cx = Math.min(gw - 1, Math.max(0, (f.x[i] / h) | 0)), cy = Math.min(gh - 1, Math.max(0, (f.y[i] / h) | 0));
      const c = cy * gw + cx; f.next[i] = f.cell[c]; f.cell[c] = i;
    }
  }
  /** One step. gx, gy: apparent gravity in g (screen x right, y down). */
  function step(f, gx, gy) {
    const p = f.p, n = f.n, x = f.x, y = f.y, vx = f.vx, vy = f.vy, h = p.h, h2 = h * h;
    const ax = gx * p.g, ay = gy * p.g;
    grid(f);
    const gw = f.gw, gh = f.gh, cell = f.cell, next = f.next;
    // viscosity impulses between approaching neighbours
    for (let i = 0; i < n; i++) {
      vx[i] += ax; vy[i] += ay;
      const cx = (x[i] / h) | 0, cy = (y[i] / h) | 0;
      for (let oy = -1; oy <= 1; oy++) { const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) { const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
          for (let j = cell[yy * gw + xx]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy;
            if (d2 >= h2 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2), q = d / h, ux = dx / d, uy = dy / d;
            const u = (vx[i] - vx[j]) * ux + (vy[i] - vy[j]) * uy;
            if (u > 0) { const I = (1 - q) * (p.sigma * u + p.beta * u * u) * 0.5; vx[i] -= I * ux; vy[i] -= I * uy; vx[j] += I * ux; vy[j] += I * uy; }
          } } }
    }
    for (let i = 0; i < n; i++) {
      let a = vx[i], b = vy[i]; const sp = Math.hypot(a, b);
      if (sp > p.maxV) { a *= p.maxV / sp; b *= p.maxV / sp; vx[i] = a; vy[i] = b; }
      f.px[i] = x[i]; f.py[i] = y[i]; x[i] += a; y[i] += b;
    }
    grid(f);
    // double density relaxation
    for (let i = 0; i < n; i++) {
      let rho = 0, rhoN = 0;
      const cx = (x[i] / h) | 0, cy = (y[i] / h) | 0;
      for (let oy = -1; oy <= 1; oy++) { const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) { const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
          for (let j = cell[yy * gw + xx]; j !== -1; j = next[j]) {
            if (j === i) continue;
            const dx = x[j] - x[i], dy = y[j] - y[i], d2 = dx * dx + dy * dy;
            if (d2 >= h2) continue;
            const q = 1 - Math.sqrt(d2) / h; rho += q * q; rhoN += q * q * q;
          } } }
      f.rho[i] = rho;
      const P0 = p.k * (rho - p.rho0), PN = p.kNear * rhoN;
      let dxi = 0, dyi = 0;
      for (let oy = -1; oy <= 1; oy++) { const yy = cy + oy; if (yy < 0 || yy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) { const xx = cx + ox; if (xx < 0 || xx >= gw) continue;
          for (let j = cell[yy * gw + xx]; j !== -1; j = next[j]) {
            if (j === i) continue;
            let dx = x[j] - x[i], dy = y[j] - y[i]; const d2 = dx * dx + dy * dy;
            if (d2 >= h2) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
            const q = 1 - d / h, D = (P0 * q + PN * q * q) * 0.5;
            const mx = (D * dx) / d, my = (D * dy) / d;
            x[j] += mx; y[j] += my; dxi -= mx; dyi -= my;
          } } }
      x[i] += dxi; y[i] += dyi;
    }
    // walls (the card) and new velocities
    const r = p.s * 0.4, W = f.w - r, B = f.H - r;
    for (let i = 0; i < n; i++) {
      let X = x[i], Y = y[i];
      let nvx = X - f.px[i], nvy = Y - f.py[i];
      if (X < r) { X = r; if (nvx < 0) nvx = -nvx * p.bounce; } else if (X > W) { X = W; if (nvx > 0) nvx = -nvx * p.bounce; }
      if (Y < r) { Y = r; if (nvy < 0) nvy = -nvy * p.bounce; } else if (Y > B) { Y = B; if (nvy > 0) nvy = -nvy * p.bounce; }
      x[i] = X; y[i] = Y; vx[i] = nvx; vy[i] = nvy; f.spd[i] = Math.hypot(nvx, nvy);
    }
    f.t++;
  }
  /** Card changed size: keep the particles, just fit them in. */
  function resize(f, w, H) {
    const sx = w / f.w;
    for (let i = 0; i < f.n; i++) { f.x[i] *= sx; f.px[i] *= sx; f.y[i] += H - f.H; f.py[i] += H - f.H; }
    f.w = w; f.H = H;
  }
  const api = { create, step, resize, P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Fluid2D = api;
})(typeof window !== 'undefined' ? window : globalThis);
