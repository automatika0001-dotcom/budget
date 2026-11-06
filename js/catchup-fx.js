/* Catch-up mode look: aqua colours, bubbles and sparks, and a glowing energy liquid in every card that sloshes
   with the phone's movement. The liquid is a real 2D particle fluid (fluid2d.js) driven straight by the
   accelerometer, drawn on the GPU as one smooth body (metaballs) with an energy shader: bright rim where the
   surface is, flowing plasma inside, foam where it moves fast, loose droplets as spray. Hard swings make the
   spray arc like chain lightning. One animation loop; it sleeps while the app is hidden. */
(function (root) {
  'use strict';
  let on = false, raf = 0, bg = null, zap = null, lastT = 0;
  // apparent gravity on the screen in units of g (x: right, y: down). Includes shakes: moving the phone right
  // pushes the liquid left, like a real glass.
  const grav = { x: 0, y: 1, live: false, src: '' };
  const fluids = new Map(); // card key -> particle fluid
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
    const k = Math.min(1, dt / 0.04);
    slow.x += (X - slow.x) * k; slow.y += (Y - slow.y) * k;
    grav.x = slow.x + (X - slow.x) * 0.7; grav.y = slow.y + (Y - slow.y) * 0.7; grav.live = true;
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
  // the glow layers are soft anyway: drawing them at 1x keeps the phone at full frame rate
  function fit(c, maxR) {
    const r = Math.min(DPR(), maxR || 1), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
    return { w, h, r };
  }


  // ---------------- GPU liquid ----------------
  const STEP = 1 / 120; // fluid step, s
  let glc = null, gl = null, progP = null, progC = null, fbo = null, ftex = null, fw = 0, fh = 0, ptBuf = null, triBuf = null;
  let pts = new Float32Array(4 * 2000);
  const VS_P = `attribute vec2 aPos; attribute vec2 aAtt; uniform vec2 uRes; uniform float uSize; varying vec2 vAtt;
    void main(){ vec2 c = aPos / uRes * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); gl_PointSize = uSize; vAtt = aAtt; }`;
  const FS_P = `precision mediump float; varying vec2 vAtt;
    void main(){ vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard;
      float k = max(0.0, exp(-r2 * 2.6) - 0.074) * 0.42;
      gl_FragColor = vec4(k, k * vAtt.x, k * vAtt.y, 0.0); }`;
  const VS_C = `attribute vec2 aP; varying vec2 vUv; void main(){ vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;
  const FS_C = `precision mediump float;
    uniform sampler2D uF; uniform vec2 uRes; uniform float uT; uniform vec4 uRect; uniform float uRad; uniform float uE;
    varying vec2 vUv;
    float sdr(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
    void main(){
      vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uRes;
      if (sdr(px - (uRect.xy + uRect.zw * 0.5), uRect.zw * 0.5, uRad) > 0.0) discard;
      vec4 f = texture2D(uF, vUv);
      float d = f.r, thr = 0.30;
      vec3 hot = mix(vec3(0.25, 0.92, 1.0), vec3(0.62, 0.48, 1.0), 0.5 + 0.5 * sin(uT * 0.35 + px.y * 0.01));
      if (d < thr) { float g = smoothstep(thr * 0.3, thr, d); gl_FragColor = vec4(hot * g * 0.16, g * 0.16); return; }
      float inner = smoothstep(thr, thr * 2.6, d);
      vec2 p = (px - uRect.xy) * 0.02; float t = uT;
      float pl = sin(p.x * 1.7 + t * 0.9 + sin(p.y * 2.1 - t * 0.7) * 1.6) + sin(p.y * 2.4 - t * 1.1 + sin(p.x * 1.3 + t * 0.5) * 2.0) + sin((p.x + p.y) * 1.1 + t * 0.6);
      float band = pow(abs(sin(pl * 1.6)), 6.0);
      vec3 deep = mix(vec3(0.08, 0.16, 0.62), vec3(0.04, 0.42, 0.95), 0.5 + 0.5 * sin(t * 0.3 + p.x * 0.35));
      vec3 col = mix(hot * 0.5, deep, inner) + hot * band * (0.45 + 0.35 * (1.0 - inner)) * (1.0 + uE * 0.6);
      float rim = 1.0 - smoothstep(thr, thr * 1.8, d);
      col += vec3(0.7, 1.0, 1.0) * rim * rim * (1.1 + 0.2 * sin(t * 2.3));
      float foam = clamp(f.g / max(d, 0.01) * 1.4 - 0.4, 0.0, 1.0);
      col += vec3(0.85, 1.0, 1.0) * foam * 0.55;
      float spray = clamp(f.b / max(d, 0.01), 0.0, 1.0);
      col += vec3(0.9, 1.0, 1.0) * spray * 0.4;
      float a = clamp(mix(0.62, 0.42, inner) + rim * 0.3 + band * 0.18 + foam * 0.2, 0.0, 0.9);
      gl_FragColor = vec4(col * a, a);
    }`;
  function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function program(vs, fs) { const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
  function glInit() {
    if (gl) return true;
    try {
      glc = layer('fxGL', 0);
      gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
      if (!gl) throw new Error('no webgl');
      progP = program(VS_P, FS_P); progC = program(VS_C, FS_C);
      ptBuf = gl.createBuffer(); triBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      ftex = gl.createTexture(); fbo = gl.createFramebuffer();
      return true;
    } catch (e) { glDrop(); return false; }
  }
  function glDrop() { if (glc) glc.remove(); glc = null; gl = null; fw = fh = 0; }
  function glSize(W, H) {
    const r = Math.min(DPR(), 1.5);
    const cw = Math.round(W * r), ch = Math.round(H * r);
    if (glc.width !== cw || glc.height !== ch) { glc.width = cw; glc.height = ch; }
    const nw = Math.max(1, Math.round(W / 2)), nh = Math.max(1, Math.round(H / 2));
    if (nw !== fw || nh !== fh) {
      fw = nw; fh = nh;
      gl.bindTexture(gl.TEXTURE_2D, ftex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ftex, 0);
    }
    return r;
  }
  // The fluid of a card, kept by its place on the screen so it survives the app redrawing the card.
  function fluidFor(card, idx, w, h) {
    const key = (card.closest('.view') || {}).id + ':' + idx;
    let f = fluids.get(key);
    if (f && (Math.abs(f.w - w) > w * 0.3 || Math.abs(f.H - h) > h * 0.3)) f = null;
    if (!f) { f = root.Fluid2D.create(w, h, 0.26, { s: 9, h: 20, rho0: 1.8, k: 1.2, kNear: 3, max: 260 }); f.energy = 0; f.arcs = []; fluids.set(key, f); }
    else if (f.w !== w || f.H !== h) root.Fluid2D.resize(f, w, h);
    f.seen = lastT;
    return f;
  }
  function stepFluids(list, dt) {
    const n = Math.max(1, Math.min(4, Math.round(dt / STEP)));
    const gx = Math.max(-1.5, Math.min(1.5, grav.x)), gy = Math.max(0.3, Math.min(1.5, grav.y));
    for (const { f } of list) for (let k = 0; k < n; k++) root.Fluid2D.step(f, gx, gy);
  }
  function drawFluids(list, W, H, t) {
    const r = glSize(W, H);
    // 1) every particle as a soft dot into a half-size field (density, speed, loose = spray)
    let total = 0; for (const { f } of list) total += f.n;
    if (pts.length < total * 4) pts = new Float32Array(total * 4 + 400);
    let o = 0;
    const loose = (f, i) => (f.rho[i] < f.p.rho0 * 0.45 ? 1 : 0);
    for (const { f, rect } of list) for (let i = 0; i < f.n; i++) {
      pts[o++] = rect.left + f.x[i]; pts[o++] = rect.top + f.y[i];
      pts[o++] = Math.min(1, f.spd[i] / 4); pts[o++] = loose(f, i);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, fw, fh);
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progP);
    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf); gl.bufferData(gl.ARRAY_BUFFER, pts.subarray(0, o), gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(progP, 'aPos'), aAtt = gl.getAttribLocation(progP, 'aAtt');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aAtt); gl.vertexAttribPointer(aAtt, 2, gl.FLOAT, false, 16, 8);
    gl.uniform2f(gl.getUniformLocation(progP, 'uRes'), W, H);
    gl.uniform1f(gl.getUniformLocation(progP, 'uSize'), 26 * (fw / W) * 2);
    gl.drawArrays(gl.POINTS, 0, o / 4);
    gl.disableVertexAttribArray(aAtt);
    // 2) the field turned into liquid, once per card, cut to the card's rounded shape
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, glc.width, glc.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(progC);
    gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
    const aP = gl.getAttribLocation(progC, 'aP'); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ftex);
    gl.uniform1i(gl.getUniformLocation(progC, 'uF'), 0);
    gl.uniform2f(gl.getUniformLocation(progC, 'uRes'), W, H);
    gl.uniform1f(gl.getUniformLocation(progC, 'uT'), t);
    gl.enable(gl.SCISSOR_TEST);
    for (const { f, rect, rad } of list) {
      gl.uniform4f(gl.getUniformLocation(progC, 'uRect'), rect.left, rect.top, rect.width, rect.height);
      gl.uniform1f(gl.getUniformLocation(progC, 'uRad'), rad);
      gl.uniform1f(gl.getUniformLocation(progC, 'uE'), Math.min(1.5, f.energy));
      const x0 = Math.max(0, Math.floor(rect.left * r)), y0 = Math.max(0, Math.floor((H - rect.bottom) * r));
      gl.scissor(x0, y0, Math.ceil(rect.width * r) + 1, Math.ceil(rect.height * r) + 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
  // Chain lightning: once a card's liquid is charged up (lots of loose fast droplets), arcs jump between them.
  function chargeAndArc(list, now) {
    for (const { f, rect } of list) {
      let loose = 0, sp = 0;
      for (let i = 0; i < f.n; i++) { sp += f.spd[i]; if (f.rho[i] < f.p.rho0 * 0.45 && f.spd[i] > 1.5) loose++; }
      const e = Math.min(2, loose / 10 + (sp / f.n) / 2.5);
      f.energy += (e - f.energy) * 0.12;
      f.arcs = f.arcs.filter((a) => a.until > now);
      if (f.energy > 0.6 && f.arcs.length < 3 && Math.random() < Math.min(0.5, (f.energy - 0.6) * 0.45)) {
        const nodes = [];
        for (let i = 0; i < f.n; i++) if (f.rho[i] < f.p.rho0 * 0.6 && f.spd[i] > 1) nodes.push(i);
        if (nodes.length > 2) {
          let cur = nodes.splice((Math.random() * nodes.length) | 0, 1)[0];
          const chain = [cur];
          for (let hop = 0; hop < 7 && nodes.length; hop++) {
            let bi = -1, bd = 90 * 90;
            for (let k = 0; k < nodes.length; k++) { const j = nodes[k], dx = f.x[j] - f.x[cur], dy = f.y[j] - f.y[cur], d2 = dx * dx + dy * dy; if (d2 < bd && d2 > 64) { bd = d2; bi = k; } }
            if (bi < 0) break;
            cur = nodes.splice(bi, 1)[0]; chain.push(cur);
          }
          if (chain.length > 1) f.arcs.push({ chain, until: now + 90 + Math.random() * 120 });
        }
      }
      f.rect = rect;
    }
  }
  function drawArcs(ctx, list, now) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const { f, rect } of list) for (const a of f.arcs) {
      const life = Math.max(0, (a.until - now) / 200);
      ctx.beginPath();
      for (let k = 1; k < a.chain.length; k++) {
        const i = a.chain[k - 1], j = a.chain[k];
        const x1 = rect.left + f.x[i], y1 = rect.top + f.y[i], x2 = rect.left + f.x[j], y2 = rect.top + f.y[j];
        const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 9));
        ctx.moveTo(x1, y1);
        for (let s = 1; s < n; s++) { const q = s / n; ctx.lineTo(x1 + (x2 - x1) * q + (Math.random() - 0.5) * 9, y1 + (y2 - y1) * q + (Math.random() - 0.5) * 9); }
        ctx.lineTo(x2, y2);
      }
      ctx.strokeStyle = `rgba(120, 200, 255, ${0.25 * life + 0.1})`; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = `rgba(160, 240, 255, ${0.6 * life + 0.25})`; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'; ctx.lineWidth = 0.8; ctx.stroke();
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
    const W = root.innerWidth, H = root.innerHeight;
    const list = [];
    if (gl || glInit()) {
      const cards = Array.from(document.querySelectorAll('.view:not([hidden]) .card'));
      cards.forEach((card, idx) => {
        const rect = card.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > H || rect.width < 40 || rect.height < 30) return;
        const rad = parseFloat(getComputedStyle(card).borderTopLeftRadius) || 18;
        list.push({ f: fluidFor(card, idx, rect.width, rect.height), rect, rad });
      });
      for (const [k, f] of fluids) if (now - f.seen > 20000) fluids.delete(k);
      stepFluids(list, dt);
      chargeAndArc(list, now);
      try { drawFluids(list, W, H, now / 1000); } catch (e) { glDrop(); }
    }
    { const { w, h, r } = fit(bg); const ctx = bg.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); stepBg(dt, w, h, ctx); }
    { const { w, h, r } = fit(zap); const ctx = zap.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0);
      stepZap(now, w, h, ctx, list.map((x) => ({ getBoundingClientRect: () => x.rect })));
      drawArcs(ctx, list, now); }
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
    fluids.clear(); bubbles.length = 0; spark = null;
    glDrop();
    if (bg) { bg.remove(); bg = null; }
    if (zap) { zap.remove(); zap = null; }
  }

  root.CatchupFX = { start, stop, askMotion, isOn: () => on, _grav: grav, _fluids: fluids };
})(window);
