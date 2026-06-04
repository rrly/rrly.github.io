// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let mode = 'raw';
let streaming = false;
let video, canvas, ctx, offCanvas, offCtx;
let handsModel = null;
let handsResult = null;
let handsProcessing = false;

// Sphere state
let sX = null, sY = null, sR = null;
let particles = [];
let sparks = [];

// Prism state
let prX = null, prY = null, prRW = null, prRH = null, prRot = 0;

// Glitch state
let glitchIntensity = 0;
let glitchTarget = 0;
let lastGlitchChange = 0;
let glitchWin = null;  // hand-tracked window {x1,y1,x2,y2}, lerped

// Pixelate state
let pixelSize = 12;
let pixelWindows = [];      // locked windows: [{x1,y1,x2,y2,ps}]
let previewWin   = null;    // live preview while hands are visible
let lockCooldown = 0;       // frame countdown — prevents instant re-lock
let lockFlash    = null;    // {x1,y1,x2,y2,alpha} brief confirmation flash
let wipeMode     = false;
let lockGestureActive = false;

// Dimensions state
let dimCorners = null;  // [4] lerped quad corners, null until first frame
let dimStars   = [];    // hyperspace star streak particles
let dimLastT   = 0;     // previous frame time for dt

// FPS
let fps = 0, fpsCount = 0, fpsLast = 0;

// Hand hover → mode selection
let hoverButton = null;  // { mode, startTime, el }

// ═══════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════
window.addEventListener('load', () => {
  video = document.getElementById('video');
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  offCanvas = document.createElement('canvas');
  offCtx = offCanvas.getContext('2d');
  initParticles();
  initDimStars();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  document.addEventListener('keydown', e => {
    if (e.key === '1') setMode('raw');
    if (e.key === '2') setMode('sphere');
    if (e.key === '3') setMode('prism');
    if (e.key === '4') setMode('glitch');
    if (e.key === '5') setMode('pixelate');
    if (e.key === '6') setMode('dimensions');
    if ((e.key === '+' || e.key === '=') && mode === 'pixelate') { pixelSize = Math.min(32, pixelSize + 2); document.getElementById('pxval').textContent = pixelSize; }
    if (e.key === '-' && mode === 'pixelate') { pixelSize = Math.max(4, pixelSize - 2); document.getElementById('pxval').textContent = pixelSize; }
    if ((e.key === 'c' || e.key === 'C') && mode === 'pixelate') { pixelWindows = []; lockFlash = null; document.getElementById('pxwins').textContent = 0; }
  });
});

function resizeCanvas() {
  const r = document.getElementById('stage').getBoundingClientRect();
  canvas.width  = Math.round(r.width);
  canvas.height = Math.round(r.height);
  offCanvas.width  = canvas.width;
  offCanvas.height = canvas.height;
}

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play();

    streaming = true;
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('stage').classList.add('live');
    const badge = document.getElementById('live-badge');
    badge.classList.add('on');
    document.getElementById('live-text').textContent = 'LIVE';

    initHands();
    document.getElementById('mode-tag').classList.add('show');
    requestAnimationFrame(renderLoop);
  } catch (e) {
    alert('Camera access denied or unavailable. Please grant camera permission and reload.');
  }
}

// ═══════════════════════════════════════════════
// MEDIAPIPE HANDS
// ═══════════════════════════════════════════════
function initHands() {
  if (typeof Hands === 'undefined') { console.warn('MediaPipe Hands not loaded'); return; }

  handsModel = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  handsModel.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.5
  });
  handsModel.onResults(r => {
    handsResult = r;
    handsProcessing = false;
    updateHandDots(r);
  });

  // Feed frames to MediaPipe at ~24fps independent of render loop
  setInterval(() => {
    if (handsModel && !handsProcessing && video.readyState >= 2) {
      handsProcessing = true;
      handsModel.send({ image: video }).catch(() => { handsProcessing = false; });
    }
  }, 42);
}

function updateHandDots(r) {
  const count = (r.multiHandLandmarks || []).length;
  document.getElementById('hd0').classList.toggle('on', count >= 1);
  document.getElementById('hd1').classList.toggle('on', count >= 2);

  const hint = document.getElementById('scan-hint');
  if (mode === 'sphere' || mode === 'prism') hint.classList.toggle('show', count === 0);
}

// ═══════════════════════════════════════════════
// MODE SWITCHING
// ═══════════════════════════════════════════════
const modeInfo = {
  raw:      { label: 'RAW',    sub: 'Unfiltered Feed' },
  sphere:   { label: 'SPHERE', sub: 'Hand-Tracked Energy Vortex' },
  glitch:   { label: 'GLITCH', sub: 'Hand-Tracked Corruption Window' },
  pixelate: { label: 'PIXEL',  sub: 'Retro Pixelation' },
  prism:      { label: 'PRISM',      sub: 'Crystal Refraction' },
  dimensions: { label: 'DIMENSIONS', sub: 'Hyperspace Portal' },
};

function setMode(m) {
  mode = m;
  document.querySelectorAll('.btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  const info = modeInfo[m];
  document.getElementById('mode-label').textContent = info.label;
  document.getElementById('mode-sub').textContent = info.sub;

  const hs = document.getElementById('hand-status');
  const hint = document.getElementById('scan-hint');
  const pxinfo = document.getElementById('pixel-info');

  const usesHands = m === 'sphere' || m === 'prism';
  hs.classList.toggle('show', usesHands);
  pxinfo.classList.toggle('show', m === 'pixelate');

  if (!usesHands) {
    hint.classList.remove('show');
    handsResult = null;
    document.getElementById('hd0').classList.remove('on');
    document.getElementById('hd1').classList.remove('on');
  }

  if (usesHands && (!handsResult || (handsResult.multiHandLandmarks || []).length === 0)) {
    hint.classList.add('show');
  }
}

// ═══════════════════════════════════════════════
// RENDER LOOP
// ═══════════════════════════════════════════════
function renderLoop(ts) {
  if (!streaming) return;

  // FPS
  fpsCount++;
  if (ts - fpsLast >= 1000) {
    fps = fpsCount; fpsCount = 0; fpsLast = ts;
    document.getElementById('fps').textContent = `${fps} FPS`;
  }

  const W = canvas.width, H = canvas.height;
  const t = ts / 1000;

  // Base: draw mirrored video
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  switch (mode) {
    case 'sphere':   renderSphere(t, W, H); break;
    case 'prism':    renderPrism(t, W, H);  break;
    case 'glitch':   renderGlitch(t, W, H); break;
    case 'pixelate':   renderPixelate(t, W, H);   break;
    case 'dimensions': renderDimensions(t, W, H); break;
    default:           drawRawFingerCursor(W, H); break;
  }

  checkHandHover(t, W, H);
  requestAnimationFrame(renderLoop);
}

// ═══════════════════════════════════════════════
// ⊛ SPHERE EFFECT
// ═══════════════════════════════════════════════
function initParticles() {
  particles = [];
  for (let i = 0; i < 90; i++) {
    const ring = Math.floor(Math.random() * 3);
    particles.push({
      angle: Math.random() * Math.PI * 2,
      speed: (0.4 + Math.random() * 1.6) * (ring % 2 === 0 ? 1 : -1),
      ringIdx: ring,
      size: 1.2 + Math.random() * 2.2,
      phase: Math.random() * Math.PI * 2,
      tiltOffset: Math.random() * Math.PI,
      alpha: 0.35 + Math.random() * 0.65,
    });
  }
}

function renderSphere(t, W, H) {
  const hands = handsResult && handsResult.multiHandLandmarks;
  const hasHands = hands && hands.length > 0;

  let targetX, targetY, targetR;

  if (hasHands) {
    let pts = [];
    for (const lm of hands) {
      // Flip x since video is mirrored
      pts.push({ x: (1 - lm[4].x) * W, y: lm[4].y * H });  // thumb tip
      pts.push({ x: (1 - lm[8].x) * W, y: lm[8].y * H });  // index tip
    }

    targetX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    targetY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const spread = pts.reduce((s, p) => s + Math.hypot(p.x - targetX, p.y - targetY), 0) / pts.length;
    targetR = Math.max(35, Math.min(220, spread * 1.3));

    // Draw hand skeleton
    for (const lm of hands) drawSkeleton(lm, W, H);

    // Draw key fingertip indicators
    for (const lm of hands) {
      for (const idx of [4, 8]) {
        const kx = (1 - lm[idx].x) * W;
        const ky = lm[idx].y * H;
        ctx.beginPath(); ctx.arc(kx, ky, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,240,255,0.18)'; ctx.fill();
        ctx.beginPath(); ctx.arc(kx, ky, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,240,255,0.95)'; ctx.fill();
      }
    }
  } else {
    // Ambient idle sphere
    targetX = W * 0.5;
    targetY = H * 0.5;
    targetR = 48 + 8 * Math.sin(t * 0.8);
  }

  // Lerp sphere position for smooth movement
  const lerp = hasHands ? 0.18 : 0.08;
  if (sX === null) { sX = targetX; sY = targetY; sR = targetR; }
  sX += (targetX - sX) * lerp;
  sY += (targetY - sY) * lerp;
  sR += (targetR - sR) * lerp;

  const alpha = hasHands ? 1.0 : 0.28;
  const hue = (t * 45) % 360;
  const pulse = 1 + 0.11 * Math.sin(t * 3.2);
  const r = sR * pulse;

  ctx.save();
  ctx.globalAlpha = alpha;

  drawSphereCore(t, sX, sY, r, hue);
  drawSphereRings(t, sX, sY, r, hue);
  drawParticles(t, sX, sY, r, hue);
  if (hasHands) drawLightRays(t, sX, sY, r, hue);
  if (hasHands) updateSparks(t, sX, sY, r, hue);

  ctx.restore();
}

function drawSkeleton(lm, W, H) {
  const CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17]
  ];
  ctx.save();
  ctx.strokeStyle = 'rgba(0,240,255,0.22)';
  ctx.lineWidth = 1;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
    ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
    ctx.stroke();
  }
  for (let i = 0; i < lm.length; i++) {
    if (i === 4 || i === 8) continue; // drawn separately
    ctx.beginPath();
    ctx.arc((1 - lm[i].x) * W, lm[i].y * H, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,240,255,0.45)';
    ctx.fill();
  }
  ctx.restore();
}

function drawSphereCore(t, cx, cy, r, hue) {
  // Outer halos
  for (let i = 3; i >= 1; i--) {
    const gr = r * (1 + i * 0.35);
    const g = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, gr);
    g.addColorStop(0, `hsla(${hue},100%,70%,${0.07 / i})`);
    g.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(cx, cy, gr, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
  }

  // Main body gradient
  const body = ctx.createRadialGradient(cx - r * 0.22, cy - r * 0.18, r * 0.04, cx, cy, r);
  body.addColorStop(0,   `hsla(${hue},60%,98%,0.92)`);
  body.addColorStop(0.18,`hsla(${hue},100%,75%,0.65)`);
  body.addColorStop(0.55,`hsla(${(hue+70)%360},100%,52%,0.28)`);
  body.addColorStop(1,   `hsla(${(hue+140)%360},100%,38%,0)`);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = body; ctx.fill();

  // Rotating inner swirl blobs
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.9);
  for (let s = 0; s < 6; s++) {
    const a = (s / 6) * Math.PI * 2 + t * 0.4;
    const bx = Math.cos(a) * r * 0.28;
    const by = Math.sin(a) * r * 0.28;
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, r * 0.52);
    bg.addColorStop(0, `hsla(${(hue + s * 55) % 360},100%,85%,0.22)`);
    bg.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(bx, by, r * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = bg; ctx.fill();
  }
  ctx.restore();

  // Inner bright core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.32);
  core.addColorStop(0, `hsla(${hue},40%,100%,0.85)`);
  core.addColorStop(0.5,`hsla(${hue},100%,82%,0.35)`);
  core.addColorStop(1, 'transparent');
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = core; ctx.fill();
}

function drawSphereRings(t, cx, cy, r, hue) {
  for (let ring = 0; ring < 3; ring++) {
    const rr = r * (0.88 + ring * 0.28);
    const spd = (ring % 2 === 0 ? 0.35 : -0.28) + ring * 0.12;
    const tilt = 0.2 + 0.35 * Math.abs(Math.cos(t * 0.25 + ring * 1.1));
    const rot = t * spd + ring * 1.04;
    const ringHue = (hue + ring * 45) % 360;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, rr, rr * tilt, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${ringHue},100%,72%,0.38)`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 11]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawParticles(t, cx, cy, r, hue) {
  const ringRadii = [r * 0.82, r * 1.13, r * 1.45];

  ctx.save();
  ctx.translate(cx, cy);

  for (const p of particles) {
    p.angle += 0.008 * p.speed;
    const pr = ringRadii[p.ringIdx];
    const tilt = 0.25 + 0.2 * Math.sin(t * 0.3 + p.tiltOffset);
    const px = Math.cos(p.angle) * pr;
    const py = Math.sin(p.angle) * pr * tilt;
    const depth = (Math.sin(p.angle) + 1) * 0.5;
    const a = p.alpha * (0.35 + depth * 0.65);
    const sz = p.size * (0.4 + depth * 0.7);
    const pHue = (hue + p.ringIdx * 55 + p.phase * 20) % 360;

    ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${pHue},100%,82%,${a})`;
    ctx.fill();

    if (depth > 0.65) {
      const glow = ctx.createRadialGradient(px, py, 0, px, py, sz * 5);
      glow.addColorStop(0, `hsla(${pHue},100%,82%,${a * 0.28})`);
      glow.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(px, py, sz * 5, 0, Math.PI * 2);
      ctx.fillStyle = glow; ctx.fill();
    }
  }

  ctx.restore();
}

function drawLightRays(t, cx, cy, r, hue) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + t * 0.28;
    const len = r * (1.6 + 0.4 * Math.sin(t * 1.8 + i));
    const a = 0.08 + 0.12 * Math.sin(t * 1.2 + i * 0.9);
    const x1 = cx + Math.cos(angle) * r * 0.55;
    const y1 = cy + Math.sin(angle) * r * 0.55;
    const x2 = cx + Math.cos(angle) * len;
    const y2 = cy + Math.sin(angle) * len;

    const rg = ctx.createLinearGradient(x1, y1, x2, y2);
    rg.addColorStop(0, `hsla(${(hue+60)%360},100%,82%,${a})`);
    rg.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = rg;
    ctx.lineWidth = 1.5 + Math.sin(t * 2.5 + i) * 0.8;
    ctx.stroke();
  }
}

function updateSparks(t, cx, cy, r, hue) {
  if (Math.random() < 0.5) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({
      x: cx + Math.cos(a) * r * 0.85,
      y: cy + Math.sin(a) * r * 0.85,
      vx: Math.cos(a) * (2.5 + Math.random() * 4.5),
      vy: Math.sin(a) * (2.5 + Math.random() * 4.5),
      life: 1,
      decay: 0.022 + Math.random() * 0.045,
      size: 1 + Math.random() * 2.5,
      hue: (hue + Math.random() * 80 - 40 + 360) % 360
    });
  }

  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx; s.y += s.vy;
    s.vx *= 0.96; s.vy *= 0.96;
    s.life -= s.decay;
    if (s.life <= 0) { sparks.splice(i, 1); continue; }

    ctx.beginPath(); ctx.arc(s.x, s.y, s.size * s.life, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${s.hue},100%,82%,${s.life * 0.9})`;
    ctx.fill();
  }

  if (sparks.length > 200) sparks.splice(0, 40);
}

// ═══════════════════════════════════════════════
// ▦ GLITCH EFFECT — hand-tracked window
// ═══════════════════════════════════════════════
function renderGlitch(t, W, H) {
  // Animate intensity regardless of window size/position
  if (t - lastGlitchChange > 0.08 + Math.random() * 0.25) {
    glitchTarget = Math.random() < 0.65 ? Math.random() * 0.35 : Math.random() * 0.9;
    lastGlitchChange = t;
  }
  glitchIntensity += (glitchTarget - glitchIntensity) * 0.12;
  const gi = glitchIntensity;

  // Track window from thumb+index (same convention as other hand modes)
  const hands = handsResult && handsResult.multiHandLandmarks;
  if (hands && hands.length > 0) {
    const pts = [];
    for (const lm of hands) {
      pts.push({ x: (1 - lm[4].x) * W, y: lm[4].y * H });
      pts.push({ x: (1 - lm[8].x) * W, y: lm[8].y * H });
    }
    const nx1 = Math.min(...pts.map(p => p.x)), ny1 = Math.min(...pts.map(p => p.y));
    const nx2 = Math.max(...pts.map(p => p.x)), ny2 = Math.max(...pts.map(p => p.y));
    const lk = 0.18;
    if (!glitchWin) { glitchWin = { x1: nx1, y1: ny1, x2: nx2, y2: ny2 }; }
    else {
      glitchWin.x1 += (nx1 - glitchWin.x1) * lk; glitchWin.y1 += (ny1 - glitchWin.y1) * lk;
      glitchWin.x2 += (nx2 - glitchWin.x2) * lk; glitchWin.y2 += (ny2 - glitchWin.y2) * lk;
    }
    // Fingertip markers
    for (const lm of hands) {
      for (const idx of [4, 8]) {
        const kx = (1 - lm[idx].x) * W, ky = lm[idx].y * H;
        ctx.beginPath(); ctx.arc(kx, ky, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,55,120,0.14)'; ctx.fill();
        ctx.beginPath(); ctx.arc(kx, ky, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,55,120,0.9)'; ctx.fill();
      }
    }
  }

  if (!glitchWin) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.font = '10px JetBrains Mono,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('· pinch thumb + index to position the glitch window  ·  move hands to resize ·', W / 2, H - 28);
    ctx.textAlign = 'left';
    ctx.restore();
    return;
  }

  // Clamp window to canvas
  const gx1 = Math.max(0, Math.round(Math.min(glitchWin.x1, glitchWin.x2)));
  const gy1 = Math.max(0, Math.round(Math.min(glitchWin.y1, glitchWin.y2)));
  const gx2 = Math.min(W, Math.round(Math.max(glitchWin.x1, glitchWin.x2)));
  const gy2 = Math.min(H, Math.round(Math.max(glitchWin.y1, glitchWin.y2)));
  const gw = gx2 - gx1, gh = gy2 - gy1;
  if (gw < 4 || gh < 4) return;

  // Pixel-level glitch operations on the window region only
  const imgData = ctx.getImageData(gx1, gy1, gw, gh);
  const d = imgData.data;
  const orig = new Uint8ClampedArray(d);

  const shift = Math.floor(gi * 28);
  if (shift > 0) {
    for (let y = 0; y < gh; y++) {
      const rs = shift + (Math.random() < gi * 0.45 ? Math.floor(Math.random() * shift * 2) : 0);
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 4;
        d[i]     = orig[(y * gw + Math.min(gw - 1, x + rs)) * 4];
        d[i + 2] = orig[(y * gw + Math.max(0, x - rs)) * 4 + 2];
      }
    }
  }

  const numLines = Math.floor(gi * 18);
  for (let n = 0; n < numLines; n++) {
    const ly = Math.floor(Math.random() * gh);
    const lh = Math.floor(Math.random() * 7) + 1;
    const off = Math.floor((Math.random() - 0.5) * 90 * gi);
    for (let dy = ly; dy < Math.min(ly + lh, gh); dy++) {
      for (let x = 0; x < gw; x++) {
        const src = (dy * gw + x) * 4;
        const dx = ((x + off) % gw + gw) % gw;
        const dstIdx = (dy * gw + dx) * 4;
        d[src] = d[dstIdx]; d[src+1] = d[dstIdx+1]; d[src+2] = d[dstIdx+2];
      }
    }
  }

  if (gi > 0.28 && Math.random() < 0.28) {
    const bx = Math.floor(Math.random() * gw);
    const by = Math.floor(Math.random() * gh);
    const bww = Math.min(Math.floor(Math.random() * 120) + 15, gw);
    const bhh = Math.min(Math.floor(Math.random() * 18) + 2, gh);
    for (let iy = by; iy < Math.min(by + bhh, gh); iy++) {
      for (let ix = bx; ix < Math.min(bx + bww, gw); ix++) {
        const ii = (iy * gw + ix) * 4;
        d[ii] = 255 - d[ii]; d[ii+1] = 255 - d[ii+1]; d[ii+2] = 255 - d[ii+2];
      }
    }
  }

  ctx.putImageData(imgData, gx1, gy1);

  // Scanlines + color wash inside window
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = gy1; y < gy2; y += 3) ctx.fillRect(gx1, y, gw, 1);
  if (gi > 0.5) {
    ctx.fillStyle = `rgba(${Math.floor(Math.random()*200)},0,${Math.floor(Math.random()*200)},${gi * 0.08})`;
    ctx.fillRect(gx1, gy1, gw, gh);
  }

  // Jittery border + corner handles
  const jx = (Math.random() - 0.5) * gi * 5, jy = (Math.random() - 0.5) * gi * 3;
  ctx.save();
  ctx.strokeStyle = `rgba(255,${Math.floor(45 + gi * 95)},${Math.floor(105 + gi * 55)},${0.55 + gi * 0.35})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(gx1 + jx, gy1 + jy, gw, gh);
  const cs = 13;
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = 'rgba(255,70,130,0.95)';
  [[gx1,gy1,1,1],[gx2,gy1,-1,1],[gx1,gy2,1,-1],[gx2,gy2,-1,-1]].forEach(([px,py,dx,dy]) => {
    ctx.beginPath(); ctx.moveTo(px+dx*cs, py); ctx.lineTo(px, py); ctx.lineTo(px, py+dy*cs); ctx.stroke();
  });
  ctx.fillStyle = `rgba(255,70,130,${gi * 0.8})`;
  ctx.font = '9px JetBrains Mono,monospace';
  ctx.fillText(`ERR::0x${(Math.random()*0xFFFFFF|0).toString(16).padStart(6,'0').toUpperCase()}`,
    gx1 + 4, gy1 > 14 ? gy1 - 4 : gy2 + 11);
  ctx.restore();
}

// ═══════════════════════════════════════════════
// ▤ PIXELATE EFFECT — hand-drawn windows
// ═══════════════════════════════════════════════

// ── Gesture detection ──────────────────────────

function fingerUp(lm, tip, pip) {
  // True when fingertip is farther from wrist than PIP joint → finger is extended
  const dTip = Math.hypot(lm[tip].x - lm[0].x, lm[tip].y - lm[0].y);
  const dPip = Math.hypot(lm[pip].x - lm[0].x, lm[pip].y - lm[0].y);
  return dTip > dPip * 0.82;
}

function isLockGesture(lm) {
  // Index extended, middle+ring+pinky curled into palm (thumb free)
  return  fingerUp(lm, 8,  6)
      && !fingerUp(lm, 12, 10)
      && !fingerUp(lm, 16, 14)
      && !fingerUp(lm, 20, 18);
}

function isWipeGesture(lm, W) {
  // Open palm: 3+ non-thumb fingers extended AND spread wide
  const ext = [fingerUp(lm,8,6), fingerUp(lm,12,10), fingerUp(lm,16,14), fingerUp(lm,20,18)].filter(Boolean).length;
  if (ext < 3) return false;
  const xs = [8,12,16,20].map(i => (1 - lm[i].x) * W);
  return Math.max(...xs) - Math.min(...xs) > W * 0.07;
}

function handBox(lm, W, H) {
  let x1 = W, y1 = H, x2 = 0, y2 = 0;
  for (const p of lm) {
    const wx = (1 - p.x) * W, wy = p.y * H;
    x1 = Math.min(x1, wx); x2 = Math.max(x2, wx);
    y1 = Math.min(y1, wy); y2 = Math.max(y2, wy);
  }
  return { x1, y1, x2, y2 };
}

function rectsOverlap(a, b) {
  return !(Math.max(a.x1,a.x2) < Math.min(b.x1,b.x2) ||
           Math.min(a.x1,a.x2) > Math.max(b.x1,b.x2) ||
           Math.max(a.y1,a.y2) < Math.min(b.y1,b.y2) ||
           Math.min(a.y1,a.y2) > Math.max(b.y1,b.y2));
}

// ── Window pixelation (reads current canvas, re-renders in blocks) ──

function applyWindowPixelate(win, W, H) {
  const ps = win.ps || pixelSize;
  const x1 = Math.max(0, Math.round(Math.min(win.x1, win.x2)));
  const y1 = Math.max(0, Math.round(Math.min(win.y1, win.y2)));
  const x2 = Math.min(W, Math.round(Math.max(win.x1, win.x2)));
  const y2 = Math.min(H, Math.round(Math.max(win.y1, win.y2)));
  const bw = x2 - x1, bh = y2 - y1;
  if (bw < 2 || bh < 2) return;

  // Reading from the display canvas directly — re-pixelating already-pixelated
  // areas produces naturally larger blocks (the layering effect)
  const snap = ctx.getImageData(x1, y1, bw, bh);
  const d = snap.data;
  const cols = Math.ceil(bw / ps), rows = Math.ceil(bh / ps);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = Math.min(col * ps + (ps >> 1), bw - 1);
      const sy = Math.min(row * ps + (ps >> 1), bh - 1);
      const ii = (sy * bw + sx) * 4;
      ctx.fillStyle = `rgb(${d[ii]},${d[ii+1]},${d[ii+2]})`;
      ctx.fillRect(x1 + col * ps, y1 + row * ps, ps, ps);
    }
  }
}

// ── Hand gesture processing for pixel mode ──────

const PX_CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function processPixelHands(hands, W, H) {
  lockGestureActive = false;
  wipeMode = false;

  // Wipe gesture takes priority — open palm sweeps away any overlapping windows
  for (const lm of hands) {
    if (!isWipeGesture(lm, W)) continue;
    wipeMode = true;
    const box = handBox(lm, W, H);
    const prev = pixelWindows.length;
    pixelWindows = pixelWindows.filter(w => !rectsOverlap(box, w));
    if (pixelWindows.length !== prev) updatePxWins();

    ctx.save();
    ctx.fillStyle = 'rgba(255,55,55,0.1)';
    ctx.strokeStyle = 'rgba(255,80,80,0.6)';
    ctx.lineWidth = 2;
    const { x1, y1, x2, y2 } = box;
    ctx.fillRect(x1, y1, x2-x1, y2-y1);
    ctx.strokeRect(x1, y1, x2-x1, y2-y1);
    ctx.fillStyle = 'rgba(255,110,110,0.8)';
    ctx.font = '9px JetBrains Mono,monospace';
    ctx.fillText('WIPE', x1 + 4, y1 + 13);
    ctx.restore();
  }

  if (wipeMode) { previewWin = null; return; }

  // Draw hand skeletons
  for (const lm of hands) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,220,255,0.18)';
    ctx.lineWidth = 1;
    for (const [a, b] of PX_CONN) {
      ctx.beginPath();
      ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
      ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
      ctx.stroke();
    }
    ctx.restore();
    if (isLockGesture(lm)) lockGestureActive = true;
  }

  // Preview window = bounding box of all thumb+index tips across all detected hands
  const pts = [];
  for (const lm of hands) {
    pts.push({ x: (1 - lm[4].x) * W, y: lm[4].y * H });
    pts.push({ x: (1 - lm[8].x) * W, y: lm[8].y * H });
  }

  if (pts.length > 0) {
    const wx1 = Math.min(...pts.map(p => p.x)), wy1 = Math.min(...pts.map(p => p.y));
    const wx2 = Math.max(...pts.map(p => p.x)), wy2 = Math.max(...pts.map(p => p.y));
    previewWin = { x1: wx1, y1: wy1, x2: wx2, y2: wy2, ps: pixelSize };

    // Fingertip markers
    for (const lm of hands) {
      for (const idx of [4, 8]) {
        const kx = (1 - lm[idx].x) * W, ky = lm[idx].y * H;
        ctx.beginPath(); ctx.arc(kx, ky, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,220,255,0.13)'; ctx.fill();
        ctx.beginPath(); ctx.arc(kx, ky, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,220,255,0.9)'; ctx.fill();
      }
    }

    // Lock: gesture active + cooldown expired + window is large enough
    if (lockGestureActive && lockCooldown === 0
        && Math.abs(wx2 - wx1) > 24 && Math.abs(wy2 - wy1) > 24) {
      pixelWindows.push({ x1: wx1, y1: wy1, x2: wx2, y2: wy2, ps: pixelSize });
      lockFlash = { x1: wx1, y1: wy1, x2: wx2, y2: wy2, alpha: 1.0 };
      lockCooldown = 48;   // ~1.6 s at 30 fps
      previewWin = null;
      updatePxWins();
    }
  }
}

// ── Window UI overlays ───────────────────────────

function drawLockedWindowsUI() {
  // Subtle labels on locked windows
  for (let i = 0; i < pixelWindows.length; i++) {
    const win = pixelWindows[i];
    const x1 = Math.min(win.x1, win.x2), y1 = Math.min(win.y1, win.y2);
    const x2 = Math.max(win.x1, win.x2), y2 = Math.max(win.y1, win.y2);
    ctx.save();
    ctx.strokeStyle = 'rgba(0,200,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, y1, x2-x1, y2-y1);
    ctx.fillStyle = 'rgba(0,200,255,0.42)';
    ctx.font = '9px JetBrains Mono,monospace';
    ctx.fillText(`W${i+1} ·${win.ps}px`, x1 + 4, y1 + 12);
    ctx.restore();
  }

  // Green flash on newly-locked window
  if (lockFlash) {
    const { x1, y1, x2, y2, alpha } = lockFlash;
    ctx.save();
    ctx.strokeStyle = `rgba(0,255,136,${alpha})`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1));
    ctx.restore();
    lockFlash.alpha -= 0.05;
    if (lockFlash.alpha <= 0) lockFlash = null;
  }
}

function drawPreviewOutline() {
  if (!previewWin) return;
  const { x1: rx1, y1: ry1, x2: rx2, y2: ry2 } = previewWin;
  const x1 = Math.min(rx1,rx2), y1 = Math.min(ry1,ry2);
  const x2 = Math.max(rx1,rx2), y2 = Math.max(ry1,ry2);
  const w = x2 - x1, h = y2 - y1;
  const col = lockGestureActive ? 'rgba(0,255,136' : 'rgba(0,240,255';

  ctx.save();
  ctx.strokeStyle = `${col},0.80)`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);

  // L-shaped corner handles
  const cs = 14;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = `${col},1)`;
  [[x1,y1,1,1],[x2,y1,-1,1],[x1,y2,1,-1],[x2,y2,-1,-1]].forEach(([px,py,dx,dy]) => {
    ctx.beginPath(); ctx.moveTo(px + dx*cs, py); ctx.lineTo(px, py); ctx.lineTo(px, py + dy*cs); ctx.stroke();
  });

  // Label above the window (or below if near top edge)
  const label = lockGestureActive
    ? `LOCKING · ${Math.round(w)}×${Math.round(h)}`
    : `${Math.round(w)}×${Math.round(h)} px:${pixelSize}`;
  ctx.fillStyle = `${col},0.75)`;
  ctx.font = '9px JetBrains Mono,monospace';
  ctx.fillText(label, x1 + 4, y1 > 16 ? y1 - 5 : y2 + 12);
  ctx.restore();
}

function updatePxWins() {
  const el = document.getElementById('pxwins');
  if (el) el.textContent = pixelWindows.length;
}

// ── Main renderPixelate ──────────────────────────

function renderPixelate(t, W, H) {
  if (lockCooldown > 0) lockCooldown--;

  // Apply locked windows in order — overlapping regions get re-pixelated,
  // which naturally increases the effective block size (the layering effect)
  for (const win of pixelWindows) applyWindowPixelate(win, W, H);

  // Apply the live preview window so the user sees real-time pixelation
  if (previewWin) applyWindowPixelate(previewWin, W, H);

  // Process hands (updates previewWin, wipeMode, lockGestureActive, pixelWindows)
  const hands = handsResult && handsResult.multiHandLandmarks;
  if (hands && hands.length > 0) {
    processPixelHands(hands, W, H);
  } else {
    previewWin = null;
    wipeMode = false;
    lockGestureActive = false;
    if (pixelWindows.length === 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.font = '10px JetBrains Mono,monospace';
      ctx.textAlign = 'center';
      ctx.fillText('· thumb + index to draw  ·  curl 3 fingers to lock  ·  open palm to wipe ·', W / 2, H - 28);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // Draw locked window labels and lock flash
  drawLockedWindowsUI();

  // Draw preview outline on top
  if (previewWin && !wipeMode) drawPreviewOutline();
}

// ═══════════════════════════════════════════════
// ◈ PRISM EFFECT
// ═══════════════════════════════════════════════

// Normalized crystal vertices — outer ring (0-9, with flat rectangular sides) + inner table quad (10-13)
// X scaled by rW, Y scaled by rH independently — proportions are NOT locked 1:1
const XTAL_NORM = [
  [ 0.00, -1.00],  // 0  top tip
  [ 0.45, -0.56],  // 1  upper-right crown shoulder
  [ 0.78, -0.28],  // 2  right-top body corner (start of flat side)
  [ 0.78,  0.28],  // 3  right-bottom body corner (end of flat side)
  [ 0.45,  0.58],  // 4  lower-right pavilion shoulder
  [ 0.00,  1.00],  // 5  bottom culet
  [-0.45,  0.58],  // 6  lower-left pavilion shoulder
  [-0.78,  0.28],  // 7  left-bottom body corner
  [-0.78, -0.28],  // 8  left-top body corner
  [-0.45, -0.56],  // 9  upper-left crown shoulder
  [ 0.36, -0.25],  // 10 table top-right
  [ 0.36,  0.22],  // 11 table bottom-right
  [-0.36,  0.22],  // 12 table bottom-left
  [-0.36, -0.25],  // 13 table top-left
];

// 12 facets fully tiling the 10-outer + 4-inner-table crystal surface
const XTAL_FACETS = [
  { v: [13, 10, 11, 12],  l: 1.00, h:   0 },  // table
  { v: [9,  0,  13],      l: 0.86, h: -18 },  // upper-left crown
  { v: [0,  10, 13],      l: 0.91, h:   2 },  // top-center fill
  { v: [0,  1,  10],      l: 0.78, h:  22 },  // upper-right crown
  { v: [8,  9,  13],      l: 0.68, h: -34 },  // left-upper transition
  { v: [1,  2,  10],      l: 0.62, h:  48 },  // right-upper transition
  { v: [7,  8,  13, 12],  l: 0.47, h: -84 },  // left body wall (flat face)
  { v: [2,  3,  11, 10],  l: 0.55, h:  72 },  // right body wall (flat face)
  { v: [6,  7,  12],      l: 0.43, h: -62 },  // lower-left transition
  { v: [3,  4,  11],      l: 0.40, h:  80 },  // lower-right transition
  { v: [5,  6,  12],      l: 0.30, h: -52 },  // lower-left pavilion
  { v: [4,  5,  12, 11],  l: 0.35, h: -22 },  // lower pavilion
];

// rW controls the crystal's width (X axis), rH controls length (Y axis) — fully independent
function xtalTransform(cx, cy, rW, rH, rot) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return XTAL_NORM.map(([nx, ny]) => {
    const sx = nx * rW, sy = ny * rH;  // scale axes independently
    return { x: cx + sx * cos - sy * sin, y: cy + sx * sin + sy * cos };
  });
}

function lerpAngle(from, to, k) {
  let diff = ((to - from) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return from + diff * k;
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function samplePx(data, fx, fy, ch, dw, dh) {
  const x = Math.max(0, Math.min(dw - 1, Math.round(fx)));
  const y = Math.max(0, Math.min(dh - 1, Math.round(fy)));
  return data[(y * dw + x) * 4 + ch];
}

function renderPrism(t, W, H) {
  const hands = handsResult && handsResult.multiHandLandmarks;
  const hasHands = hands && hands.length > 0;

  let targetX, targetY, targetRW, targetRH, targetRot;

  if (hasHands) {
    if (hands.length >= 2) {
      // Two hands: crystal stretches between hand centers; width set by pinch distance
      const h1 = hands[0], h2 = hands[1];
      const m1x = ((1 - h1[4].x) + (1 - h1[8].x)) / 2 * W;
      const m1y = (h1[4].y + h1[8].y) / 2 * H;
      const m2x = ((1 - h2[4].x) + (1 - h2[8].x)) / 2 * W;
      const m2y = (h2[4].y + h2[8].y) / 2 * H;
      targetX = (m1x + m2x) / 2;
      targetY = (m1y + m2y) / 2;
      const handDist = Math.hypot(m2x - m1x, m2y - m1y);
      targetRH = Math.max(50, Math.min(320, handDist * 0.55));
      const pinch1 = Math.hypot((1 - h1[4].x - (1 - h1[8].x)) * W, (h1[4].y - h1[8].y) * H);
      const pinch2 = Math.hypot((1 - h2[4].x - (1 - h2[8].x)) * W, (h2[4].y - h2[8].y) * H);
      targetRW = Math.max(18, Math.min(110, (pinch1 + pinch2) * 0.20));
      // Crystal Y-axis (long axis) aligns with the hand-to-hand direction
      targetRot = Math.atan2(m2y - m1y, m2x - m1x) - Math.PI / 2;
    } else {
      // One hand: crystal from thumb tip to index tip
      const lm = hands[0];
      const tx = (1 - lm[4].x) * W, ty = lm[4].y * H;
      const ix = (1 - lm[8].x) * W, iy = lm[8].y * H;
      targetX = (tx + ix) / 2;
      targetY = (ty + iy) / 2;
      const len = Math.hypot(ix - tx, iy - ty);
      targetRH = Math.max(35, Math.min(220, len * 1.1));
      targetRW = Math.max(18, Math.min(80, len * 0.28));
      targetRot = Math.atan2(iy - ty, ix - tx) - Math.PI / 2;
    }

    for (const lm of hands) {
      ctx.save();
      ctx.strokeStyle = 'rgba(160,140,255,0.2)';
      const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
      ctx.lineWidth = 1;
      for (const [a, b] of CONN) {
        ctx.beginPath();
        ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
        ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
        ctx.stroke();
      }
      for (let i = 0; i < lm.length; i++) {
        ctx.beginPath(); ctx.arc((1 - lm[i].x) * W, lm[i].y * H, i === 4 || i === 8 ? 5 : 2, 0, Math.PI * 2);
        ctx.fillStyle = i === 4 || i === 8 ? 'rgba(200,180,255,0.95)' : 'rgba(160,140,255,0.4)';
        ctx.fill();
      }
      ctx.restore();
    }
  } else {
    // Idle: tall narrow crystal rotating slowly to showcase the rectangular shape
    targetX = W * 0.5; targetY = H * 0.5;
    targetRH = 95; targetRW = 30;
    targetRot = t * 0.08;
  }

  const lerpK = hasHands ? 0.14 : 0.06;
  if (prX === null) { prX = targetX; prY = targetY; prRW = targetRW; prRH = targetRH; prRot = targetRot; }
  prX  += (targetX   - prX)  * lerpK;
  prY  += (targetY   - prY)  * lerpK;
  prRW += (targetRW  - prRW) * lerpK;
  prRH += (targetRH  - prRH) * lerpK;
  prRot = lerpAngle(prRot, targetRot, lerpK);

  const breathe = 1 + 0.022 * Math.sin(t * 1.8);
  const rW = prRW * breathe, rH = prRH * breathe;
  const hue = (t * 28 + 210) % 360;

  const verts = xtalTransform(prX, prY, rW, rH, prRot);
  const outerPoly = verts.slice(0, 10);

  ctx.save();
  ctx.globalAlpha = hasHands ? 1.0 : 0.22;

  applyPrismRefraction(t, prX, prY, rW, rH, outerPoly, W, H);
  drawCrystalFacets(t, verts, hue);
  drawCrystalGlow(t, prX, prY, rW, rH, outerPoly, verts, hue);
  if (hasHands) drawRainbowBeam(t, prX, prY, rW, rH, prRot);

  ctx.restore();
}

function applyPrismRefraction(t, cx, cy, rW, rH, outerPoly, W, H) {
  const rMax = Math.max(rW, rH);
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (const p of outerPoly) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  minX = Math.max(0, Math.floor(minX) - 2);
  minY = Math.max(0, Math.floor(minY) - 2);
  maxX = Math.min(W, Math.ceil(maxX) + 2);
  maxY = Math.min(H, Math.ceil(maxY) + 2);
  const bw = maxX - minX, bh = maxY - minY;
  if (bw < 4 || bh < 4) return;

  // Snapshot current canvas (mirrored video) to offscreen
  offCtx.clearRect(0, 0, W, H);
  offCtx.drawImage(canvas, 0, 0);
  const snap = offCtx.getImageData(minX, minY, bw, bh);
  const sd = snap.data;

  const dst = new Uint8ClampedArray(sd.length);
  dst.set(sd);

  const slow = t * 0.2;

  for (let py = 0; py < bh; py++) {
    const wy = minY + py;
    for (let px = 0; px < bw; px++) {
      const wx = minX + px;
      if (!pointInPoly(wx, wy, outerPoly)) continue;

      const dx = wx - cx, dy = wy - cy;
      const dist = Math.hypot(dx, dy);
      const norm = Math.min(1, dist / rMax);
      const angle = Math.atan2(dy, dx);

      // Convex-lens barrel distortion — magnifies toward center
      const barrel = 0.2 * (1 - norm * norm);
      const rsx = cx + dx * (1 + barrel) - minX;
      const rsy = cy + dy * (1 + barrel) - minY;

      // Chromatic aberration — splits R outward, B inward along the refraction angle
      // Intensity strongest at center (where glass is thickest), fades at edges
      const chroma = 12 * (1 - norm) * (0.6 + 0.4 * Math.sin(slow + angle * 3));

      const i = (py * bw + px) * 4;
      dst[i]   = samplePx(sd, rsx + Math.cos(angle) * chroma,    rsy + Math.sin(angle) * chroma,    0, bw, bh);
      dst[i+1] = samplePx(sd, rsx,                               rsy,                               1, bw, bh);
      dst[i+2] = samplePx(sd, rsx - Math.cos(angle) * chroma,    rsy - Math.sin(angle) * chroma,    2, bw, bh);
      dst[i+3] = 255;
    }
  }

  // Write distorted pixels to offscreen, then draw to main canvas with a soft blur.
  // The crystal clip path creates the frosted-glass edge fade.
  offCtx.clearRect(0, 0, W, H);
  offCtx.putImageData(new ImageData(dst, bw, bh), minX, minY);

  ctx.save();
  ctx.beginPath();
  outerPoly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip();
  const blurPx = Math.max(1.5, Math.min(3.5, Math.min(rW, rH) * 0.022)).toFixed(1);
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(offCanvas, 0, 0);
  ctx.filter = 'none';
  ctx.restore();
}

function drawCrystalFacets(t, verts, hue) {
  const shimmer = Math.sin(t * 5.2) * 0.035;
  for (const f of XTAL_FACETS) {
    const fv = f.v.map(i => verts[i]);
    ctx.beginPath();
    ctx.moveTo(fv[0].x, fv[0].y);
    for (let k = 1; k < fv.length; k++) ctx.lineTo(fv[k].x, fv[k].y);
    ctx.closePath();

    const fHue = (hue + f.h + 360) % 360;
    const lv = Math.max(0, Math.min(1, f.l + shimmer * (f.l > 0.6 ? 1.2 : -0.5)));
    const lightness = 30 + lv * 52;
    const alpha = 0.18 + lv * 0.24;

    // Fill: semi-transparent glass color
    ctx.fillStyle = `hsla(${fHue},75%,${lightness.toFixed(0)}%,${alpha.toFixed(3)})`;
    ctx.fill();
  }
}

function drawCrystalGlow(t, cx, cy, rW, rH, outerPoly, verts, hue) {
  function outerPath() {
    ctx.beginPath();
    ctx.moveTo(outerPoly[0].x, outerPoly[0].y);
    for (let i = 1; i < outerPoly.length; i++) ctx.lineTo(outerPoly[i].x, outerPoly[i].y);
    ctx.closePath();
  }

  // Soft bloom — CSS blur filter gives natural Gaussian falloff
  ctx.save();
  ctx.filter = 'blur(10px)';
  for (let layer = 4; layer >= 1; layer--) {
    outerPath();
    ctx.strokeStyle = `hsla(${hue},100%,80%,${0.13 / layer})`;
    ctx.lineWidth = layer * 18;
    ctx.stroke();
  }
  ctx.filter = 'none';
  ctx.restore();

  // Crisp outer edge with shadow glow
  ctx.save();
  ctx.shadowColor = `hsl(${hue},100%,78%)`;
  ctx.shadowBlur = 24;
  outerPath();
  ctx.strokeStyle = `hsla(${hue},100%,90%,0.72)`;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Inner facet edges — soft blur on these too so they read as internal light
  const innerEdges = [
    [verts[13], verts[10]], [verts[10], verts[11]], [verts[11], verts[12]], [verts[12], verts[13]],
    [verts[0],  verts[13]], [verts[0],  verts[10]],
    [verts[1],  verts[10]], [verts[2],  verts[10]], [verts[2],  verts[11]],
    [verts[3],  verts[11]], [verts[4],  verts[11]],
    [verts[6],  verts[12]], [verts[7],  verts[12]], [verts[7],  verts[13]],
    [verts[8],  verts[13]], [verts[9],  verts[13]],
  ];
  ctx.shadowBlur = 14;
  ctx.strokeStyle = `hsla(${(hue + 25) % 360},100%,92%,0.32)`;
  ctx.lineWidth = 0.8;
  for (const [a, b] of innerEdges) {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();

  // Specular highlight on the table facet (animated sparkle)
  const sparkPeak = 0.55 + 0.45 * Math.sin(t * 6.0);
  const tCx = (verts[10].x + verts[11].x + verts[12].x + verts[13].x) / 4;
  const tCy = (verts[10].y + verts[11].y + verts[12].y + verts[13].y) / 4;
  const specR = rW * 0.42;
  const specGrad = ctx.createRadialGradient(tCx - rW*0.04, tCy - rH*0.04, 0, tCx, tCy, specR);
  specGrad.addColorStop(0, `rgba(255,255,255,${(0.75 * sparkPeak).toFixed(3)})`);
  specGrad.addColorStop(0.35, `hsla(${hue},70%,95%,${(0.30 * sparkPeak).toFixed(3)})`);
  specGrad.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.moveTo(verts[13].x, verts[13].y);
  ctx.lineTo(verts[10].x, verts[10].y);
  ctx.lineTo(verts[11].x, verts[11].y);
  ctx.lineTo(verts[12].x, verts[12].y);
  ctx.closePath();
  ctx.fillStyle = specGrad;
  ctx.fill();

  // Cross-flare star on the specular peak
  if (sparkPeak > 0.8) {
    const fAlpha = (sparkPeak - 0.8) * 4;
    const fLen = Math.min(rW, rH) * 0.45 * fAlpha;
    ctx.save();
    ctx.globalAlpha = fAlpha * 0.7;
    for (let arm = 0; arm < 4; arm++) {
      const a = (arm / 4) * Math.PI;
      const g = ctx.createLinearGradient(tCx - Math.cos(a)*fLen, tCy - Math.sin(a)*fLen, tCx + Math.cos(a)*fLen, tCy + Math.sin(a)*fLen);
      g.addColorStop(0, 'transparent');
      g.addColorStop(0.5, `rgba(255,255,255,0.9)`);
      g.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.moveTo(tCx - Math.cos(a)*fLen, tCy - Math.sin(a)*fLen);
      ctx.lineTo(tCx + Math.cos(a)*fLen, tCy + Math.sin(a)*fLen);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawRainbowBeam(t, cx, cy, rW, rH, rot) {
  // Beam exits through the right body wall — along the crystal's local X axis
  // In world space the crystal's X axis points in direction (cos(rot), sin(rot))
  const sideAngle = rot + 0.10 * Math.sin(t * 0.45);  // slight wobble
  const baseAngle = sideAngle;
  const spread = 0.40;
  const beamLen = rH * 3.2;
  const originX = cx + Math.cos(rot) * rW * 0.82;
  const originY = cy + Math.sin(rot) * rW * 0.82;

  const RAINBOW = [0, 28, 55, 120, 195, 265]; // R O Y G B V hues
  const n = RAINBOW.length;

  ctx.save();
  ctx.globalAlpha = 0.22;

  for (let i = 0; i < n; i++) {
    const a1 = baseAngle - spread + (i / n) * spread * 2;
    const a2 = baseAngle - spread + ((i + 1) / n) * spread * 2;
    const aMid = (a1 + a2) / 2;

    const ex = cx + Math.cos(aMid) * beamLen;
    const ey = cy + Math.sin(aMid) * beamLen;

    const sg = ctx.createLinearGradient(originX, originY, ex, ey);
    sg.addColorStop(0,   `hsla(${RAINBOW[i]},100%,70%,0.70)`);
    sg.addColorStop(0.45,`hsla(${RAINBOW[i]},100%,62%,0.30)`);
    sg.addColorStop(1,   `hsla(${RAINBOW[i]},100%,60%,0.00)`);

    // Fan slice as a triangle
    const ex1 = cx + Math.cos(a1) * beamLen;
    const ey1 = cy + Math.sin(a1) * beamLen;
    const ex2 = cx + Math.cos(a2) * beamLen;
    const ey2 = cy + Math.sin(a2) * beamLen;

    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(ex1, ey1);
    ctx.lineTo(ex2, ey2);
    ctx.closePath();
    ctx.fillStyle = sg;
    ctx.fill();
  }

  ctx.restore();
}

// ═══════════════════════════════════════════════
// FINGER CURSOR (raw mode) + HAND HOVER SELECTION
// ═══════════════════════════════════════════════

function drawRawFingerCursor(W, H) {
  const hands = handsResult && handsResult.multiHandLandmarks;
  if (!hands) return;
  for (const lm of hands) {
    const ix = (1 - lm[8].x) * W, iy = lm[8].y * H;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ix, iy, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath(); ctx.arc(ix, iy, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

function checkHandHover(t, W, H) {
  const hands = handsResult && handsResult.multiHandLandmarks;
  const timerEl = document.getElementById('hover-timer');
  const ringEl  = timerEl.querySelector('.ht-ring');
  const countEl = document.getElementById('ht-count');

  if (!hands || hands.length === 0) {
    if (hoverButton) { hoverButton.el.classList.remove('hover-select'); hoverButton = null; }
    timerEl.style.display = 'none';
    return;
  }

  // Use index fingertip (landmark 8) of the first detected hand as the pointer.
  // Canvas coords are stage-local; button rects are viewport-relative — bridge the gap.
  const lm = hands[0];
  const ix = (1 - lm[8].x) * W;  // stage-local x
  const iy = lm[8].y * H;         // stage-local y
  const stageRect = document.getElementById('stage').getBoundingClientRect();
  const vx = ix + stageRect.left;  // viewport x
  const vy = iy + stageRect.top;   // viewport y

  let foundEl = null, foundMode = null;
  document.querySelectorAll('.btn').forEach(btn => {
    const r = btn.getBoundingClientRect();
    if (vx >= r.left && vx <= r.right && vy >= r.top && vy <= r.bottom) {
      foundEl = btn; foundMode = btn.dataset.mode;
    }
  });

  // Switched target — reset
  if (hoverButton && hoverButton.el !== foundEl) {
    hoverButton.el.classList.remove('hover-select');
    hoverButton = null;
    timerEl.style.display = 'none';
  }

  if (!foundEl) return;

  if (!hoverButton) hoverButton = { mode: foundMode, startTime: t, el: foundEl };

  const elapsed  = t - hoverButton.startTime;
  const progress = Math.min(1, elapsed / 5.0);

  foundEl.classList.add('hover-select');

  // Position timer over the button — convert from viewport to stage-local coords
  const rect = foundEl.getBoundingClientRect();
  timerEl.style.display = 'block';
  timerEl.style.left = (rect.left - stageRect.left + rect.width  / 2) + 'px';
  timerEl.style.top  = (rect.top  - stageRect.top  + rect.height / 2) + 'px';

  const circ = 119.4;
  ringEl.style.strokeDashoffset = (circ * (1 - progress)).toFixed(2);
  countEl.textContent = Math.max(1, Math.ceil(5 - elapsed));

  if (progress >= 1) {
    setMode(foundMode);
    foundEl.classList.remove('hover-select');
    hoverButton = null;
    timerEl.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════
// ⊕ DIMENSIONS EFFECT — hyperspace portal
// ═══════════════════════════════════════════════

function initDimStars() {
  dimStars = [];
  for (let i = 0; i < 220; i++) dimStars.push(newDimStar());
}

function newDimStar() {
  return {
    angle:       Math.random() * Math.PI * 2,
    dist:        Math.random() * 14,               // starts close to center
    speed:       130 + Math.random() * 420,        // wider speed range — more variety
    size:        0.3 + Math.random() * 3.5,        // some stars are chunky
    colorOffset: Math.floor(Math.random() * 360),
    bright:      0.5 + Math.random() * 0.5,
  };
}

// Gently breathing rectangular idle quad (shown when no hands detected)
function idleQuadCorners(t, W, H) {
  const cx = W * 0.5, cy = H * 0.5;
  const rx = W * 0.28, ry = H * 0.30;
  const wb = 0.04 * Math.sin(t * 0.55);
  return [
    { x: cx - rx * (1 + wb), y: cy - ry * (1 - wb) },  // [0] top-left
    { x: cx + rx * (1 - wb), y: cy - ry * (1 + wb) },  // [1] top-right
    { x: cx + rx * (1 + wb), y: cy + ry * (1 - wb) },  // [2] bottom-right
    { x: cx - rx * (1 - wb), y: cy + ry * (1 + wb) },  // [3] bottom-left
  ];
}

function renderDimensions(t, W, H) {
  // dt capped at 50 ms so large pauses don't teleport stars
  const dt = Math.min(t - dimLastT, 0.05);
  dimLastT = t;

  const hands = handsResult && handsResult.multiHandLandmarks;
  const hasHands = hands && hands.length >= 2;

  // ── Determine target quad corners ─────────────
  // Corner order: [0] h1-thumb, [1] h1-index, [2] h2-index, [3] h2-thumb
  // Tracing [0]→[1]→[2]→[3]→[0] forms a natural window when both hands are raised.
  let targetCorners;
  if (hasHands) {
    const h1 = hands[0], h2 = hands[1];
    targetCorners = [
      { x: (1 - h1[4].x) * W, y: h1[4].y * H },
      { x: (1 - h1[8].x) * W, y: h1[8].y * H },
      { x: (1 - h2[8].x) * W, y: h2[8].y * H },
      { x: (1 - h2[4].x) * W, y: h2[4].y * H },
    ];
  } else {
    targetCorners = idleQuadCorners(t, W, H);
  }

  // Lerp each corner toward its target
  const lk = hasHands ? 0.16 : 0.05;
  if (!dimCorners) {
    dimCorners = targetCorners.map(p => ({ ...p }));
  } else {
    for (let i = 0; i < 4; i++) {
      dimCorners[i].x += (targetCorners[i].x - dimCorners[i].x) * lk;
      dimCorners[i].y += (targetCorners[i].y - dimCorners[i].y) * lk;
    }
  }

  const C = dimCorners;
  const cx = (C[0].x + C[1].x + C[2].x + C[3].x) / 4;
  const cy = (C[0].y + C[1].y + C[2].y + C[3].y) / 4;
  // Portal "radius" — furthest corner from center, used to scale star distances
  const qr = Math.max(...C.map(p => Math.hypot(p.x - cx, p.y - cy)));

  // Hue cycles aggressively — full spectrum sweep every ~4 seconds
  const hue = (t * 90 + 210) % 360;

  // Active vs idle intensity — only the idle branch changes; active values stay as-is
  const warpLayers = hasHands ? 12   : 4;
  const warpScale  = hasHands ? 0.15 : 0.05;
  const warpAlpha  = hasHands ? 0.22 : 0.07;
  const nebulaRate = hasHands ? 1.0  : 0.22;   // orbit speed multiplier
  const starAccel  = hasHands ? 9.0  : 1.8;    // radial acceleration multiplier
  const pulseFreq  = hasHands ? 16.0 : 3.5;    // core pulse Hz
  const flareScale = hasHands ? 0.75 : 0.25;   // flare arm length as fraction of qr

  // ── Inside the quad ───────────────────────────
  ctx.save();
  if (!hasHands) ctx.globalAlpha = 0.16;

  // Clip to the (potentially irregular) quadrilateral
  ctx.beginPath();
  ctx.moveTo(C[0].x, C[0].y);
  ctx.lineTo(C[1].x, C[1].y);
  ctx.lineTo(C[2].x, C[2].y);
  ctx.lineTo(C[3].x, C[3].y);
  ctx.closePath();
  ctx.clip();

  // (0) Inverted webcam base — overwrite normal webcam within the quad with inverted colors
  ctx.save();
  ctx.filter = 'invert(1)';
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  // (A) Speed-warp blur — 12 zoom copies, large scale jumps for extreme tunnel feel
  // Snapshot taken after inversion so warp trails are also inverted
  offCtx.clearRect(0, 0, W, H);
  offCtx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let layer = warpLayers; layer >= 1; layer--) {
    const scale = 1 + layer * warpScale;
    const a = Math.max(0, warpAlpha - layer * 0.016);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(offCanvas, 0, 0);
    ctx.restore();
  }
  ctx.restore();

  // (B) Deep space vignette — very dark edges to sell the tunnel depth
  const vig = ctx.createRadialGradient(cx, cy, qr * 0.08, cx, cy, qr * 1.35);
  vig.addColorStop(0,   'rgba(0,0,18,0.00)');
  vig.addColorStop(0.45,'rgba(0,0,22,0.45)');
  vig.addColorStop(1,   'rgba(0,0,40,0.95)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  // (C) Nebula cloud overlays — 8 high-saturation blobs, fast orbit, thick opacity
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 8; i++) {
    const ang = t * (0.14 + i * 0.07) * nebulaRate + i * (Math.PI * 2 / 8);
    const nx  = cx + Math.cos(ang) * qr * 0.48;
    const ny  = cy + Math.sin(ang) * qr * 0.38;
    const nr  = qr * (0.60 + i * 0.12);
    const ch  = (hue + i * 45) % 360;
    const g   = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
    g.addColorStop(0,   `hsla(${ch},100%,68%,0.42)`);
    g.addColorStop(0.40,`hsla(${ch},100%,50%,0.18)`);
    g.addColorStop(1,   'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();

  // (D) Star streaks — massive particle count, extreme acceleration, wide bright trails
  for (let i = dimStars.length - 1; i >= 0; i--) {
    const s = dimStars[i];
    const prev = s.dist;
    s.dist += s.speed * dt * (1 + prev / qr * starAccel);
    if (s.dist > qr * 1.35) { dimStars[i] = newDimStar(); continue; }

    const x1 = cx + Math.cos(s.angle) * prev;
    const y1 = cy + Math.sin(s.angle) * prev;
    const x2 = cx + Math.cos(s.angle) * s.dist;
    const y2 = cy + Math.sin(s.angle) * s.dist;

    const nd = s.dist / qr;
    const a  = Math.min(1, nd * 5.0) * s.bright;   // fade in faster, hit full brightness sooner
    const w  = s.size * (0.5 + nd * 9.0);           // much wider at edge — dramatic tail
    const sh = (hue + s.colorOffset) % 360;

    const gr = ctx.createLinearGradient(x1, y1, x2, y2);
    gr.addColorStop(0, `hsla(${sh},100%,95%,0)`);
    gr.addColorStop(1, `hsla(${sh},100%,100%,${a})`);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = gr; ctx.lineWidth = w; ctx.stroke();
  }
  while (dimStars.length < 380) dimStars.push(newDimStar());

  // (E) Warp core — massive pulsing singularity, high-frequency pulse
  const pulse = 0.55 + 0.45 * Math.sin(t * pulseFreq);
  const coreR = qr * 0.26 * pulse;
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 7);
  cg.addColorStop(0,    `rgba(255,255,255,${1.0 * pulse})`);
  cg.addColorStop(0.05, `hsla(${hue},100%,98%,${0.90 * pulse})`);
  cg.addColorStop(0.18, `hsla(${hue},100%,80%,0.65)`);
  cg.addColorStop(0.45, `hsla(${(hue+55)%360},100%,55%,0.30)`);
  cg.addColorStop(0.80, `hsla(${(hue+120)%360},100%,35%,0.12)`);
  cg.addColorStop(1,    'transparent');
  ctx.beginPath(); ctx.arc(cx, cy, coreR * 7, 0, Math.PI * 2);
  ctx.fillStyle = cg; ctx.fill();

  // (F) 6-arm lens flare — long, thick, blinding
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const flareLen = qr * flareScale * pulse;
  for (let arm = 0; arm < 6; arm++) {
    const a = (arm / 6) * Math.PI;
    const fg = ctx.createLinearGradient(
      cx - Math.cos(a) * flareLen, cy - Math.sin(a) * flareLen,
      cx + Math.cos(a) * flareLen, cy + Math.sin(a) * flareLen
    );
    fg.addColorStop(0,   'transparent');
    fg.addColorStop(0.5, `rgba(255,255,255,${0.90 * pulse})`);
    fg.addColorStop(1,   'transparent');
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * flareLen, cy - Math.sin(a) * flareLen);
    ctx.lineTo(cx + Math.cos(a) * flareLen, cy + Math.sin(a) * flareLen);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 3.5 + pulse * 5.5;
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore(); // ── end clip ──────────────────────────────────

  // ── Quad edges — glowing electric outline ─────

  // Massive layered bloom — 5 blurred passes at increasing width
  ctx.save();
  ctx.filter = 'blur(18px)';
  for (let b = 5; b >= 1; b--) {
    ctx.beginPath();
    ctx.moveTo(C[0].x, C[0].y); ctx.lineTo(C[1].x, C[1].y);
    ctx.lineTo(C[2].x, C[2].y); ctx.lineTo(C[3].x, C[3].y);
    ctx.closePath();
    ctx.strokeStyle = `hsla(${hue},100%,80%,${0.22 / b})`;
    ctx.lineWidth = b * 28;
    ctx.stroke();
  }
  ctx.filter = 'none';
  ctx.restore();

  // Solid glowing edge — thick, bright
  ctx.save();
  ctx.shadowColor = `hsl(${hue},100%,85%)`;
  ctx.shadowBlur = 40;
  ctx.strokeStyle = `hsla(${hue},100%,96%,0.95)`;
  ctx.lineWidth = 3.0;
  ctx.beginPath();
  ctx.moveTo(C[0].x, C[0].y); ctx.lineTo(C[1].x, C[1].y);
  ctx.lineTo(C[2].x, C[2].y); ctx.lineTo(C[3].x, C[3].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // Animated dashed edge on top — faster march
  ctx.save();
  ctx.shadowColor = `hsl(${(hue+60)%360},100%,90%)`;
  ctx.shadowBlur = 16;
  ctx.strokeStyle = `hsla(${(hue+60)%360},100%,98%,0.75)`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -(t * 160 % 20);
  ctx.beginPath();
  ctx.moveTo(C[0].x, C[0].y); ctx.lineTo(C[1].x, C[1].y);
  ctx.lineTo(C[2].x, C[2].y); ctx.lineTo(C[3].x, C[3].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // ── Fingertip corner markers ───────────────────
  if (hasHands) {
    for (const lm of hands) {
      for (const idx of [4, 8]) {
        const kx = (1 - lm[idx].x) * W, ky = lm[idx].y * H;
        ctx.beginPath(); ctx.arc(kx, ky, 12, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue},100%,82%,0.18)`; ctx.fill();
        ctx.beginPath(); ctx.arc(kx, ky, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue},100%,95%,0.92)`; ctx.fill();
      }
    }
  }

  // ── Hint when no hands ─────────────────────────
  if (!hasHands) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.font = '10px JetBrains Mono,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('· raise both hands · thumb + index of each hand mark the portal corners ·', W / 2, H - 28);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}
