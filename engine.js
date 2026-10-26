// Effects engine. Runs inside a hidden extension iframe (so MediaPipe's
// WebAssembly is never blocked by the call site's security policy).
// Receives camera frames from the page, returns processed frames.
import { FilesetResolver, HandLandmarker, PoseLandmarker, FaceLandmarker } from './lib/vision_bundle.mjs';

// ------------------------------------------------------------------ settings
const settings = {
  enabled: true, snap: true, cash: true, cinema: true, showText: true,
  debug: false, sensitivity: 'normal', meme: null,
  bgBlur: false, facepalm: true, palmMeme: null,
};
let palmBmp = null;
const PALM_OPACITY = 0.5;

async function loadPalmMeme(dataUrl) {
  palmBmp = null;
  try {
    const img = new Image();
    img.src = dataUrl || chrome.runtime.getURL('memes/facepalm.png');
    await img.decode();
    palmBmp = await createImageBitmap(img);
  } catch (e) { console.warn('facepalm image failed to load', e); }
}
let memeBmp = null;
let memeFace = null; // eye positions in the meme picture (normalized)

const SENS = {
  low:    { pinch: 0.38, curl: 0.16 },
  normal: { pinch: 0.46, curl: 0.10 },
  high:   { pinch: 0.56, curl: 0.05 },
};

function post(msg, transfer) {
  window.parent.postMessage(Object.assign({ __snapfx: 1 }, msg), '*', transfer || []);
}

// ------------------------------------------------------------------ models
let fileset = null, hand = null, pose = null, faceLive = null, ready = false;

async function createTask(Cls, path, opts) {
  let lastErr;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Cls.createFromOptions(fileset, Object.assign({
        baseOptions: { modelAssetPath: chrome.runtime.getURL(path), delegate },
        runningMode: 'VIDEO',
      }, opts));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

function faceKeyPoints(lm) {
  const avg = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
  return { e1: avg(33, 133), e2: avg(362, 263), oval: FACE_OVAL.map((i) => ({ x: lm[i].x, y: lm[i].y })) };
}

async function loadMeme(dataUrl) {
  memeBmp = null; memeFace = null;
  try {
    const img = new Image();
    img.src = dataUrl || chrome.runtime.getURL('memes/absolute-cinema.jpg');
    await img.decode();
    memeBmp = await createImageBitmap(img);
  } catch (e) { console.warn('meme image failed to load', e); return; }
  await findMemeFace();
}

async function findMemeFace() {
  if (!memeBmp || !fileset) return;
  try {
    const det = await createTask(FaceLandmarker, 'models/face_landmarker.task', { runningMode: 'IMAGE', numFaces: 1 });
    const r = det.detect(memeBmp);
    det.close();
    const lm = r.faceLandmarks && r.faceLandmarks[0];
    memeFace = lm ? faceKeyPoints(lm) : null;
    if (memeFace) memeFace.gray = sampleGray(memeBmp, memeFace, memeBmp.width, memeBmp.height);
  } catch (e) { console.warn('could not find a face in the meme picture', e); memeFace = null; }
}

async function loadSettings() {
  const s = await chrome.storage.local.get(settings);
  Object.assign(settings, s);
  chrome.storage.onChanged.addListener(async (ch) => {
    for (const k of Object.keys(ch)) if (k in settings) settings[k] = ch[k].newValue;
    if (ch.meme) await loadMeme(settings.meme);
    if (ch.palmMeme) await loadPalmMeme(settings.palmMeme);
    if (ch.enabled) post({ type: 'active', value: settings.enabled !== false });
  });
}

async function init() {
  try {
    await loadSettings();
    fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('lib/wasm'));
    hand = await createTask(HandLandmarker, 'models/hand_landmarker.task', {
      numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    pose = await createTask(PoseLandmarker, 'models/pose_landmarker_lite.task', {
      numPoses: 1, outputSegmentationMasks: true,
    });
    faceLive = await createTask(FaceLandmarker, 'models/face_landmarker.task', { numFaces: 1 });
    await loadMeme(settings.meme);
    await loadPalmMeme(settings.palmMeme);
    ready = true;
    post({ type: 'ready' });
    post({ type: 'active', value: settings.enabled !== false });
  } catch (e) {
    console.error(e);
    post({ type: 'error', message: 'Engine failed to start: ' + (e && e.message || e) });
  }
}

// ------------------------------------------------------------------ canvases
let W = 0, H = 0, MW = 0, MH = 0;
const GW = 128; let GH = 72;
const PW = 160; let PH = 90;
const C = {};
function makeCanvas(name, w, h, opts) {
  const c = new OffscreenCanvas(w, h);
  C[name] = c;
  C[name + 'Ctx'] = c.getContext('2d', opts || {});
  return C[name + 'Ctx'];
}

let maskImg = null, looseImg = null, aliveImg = null, partImg = null, part32 = null, ppImg = null;
let grainPattern = null;
let bgFrames = 0;
let billSprites = [];

function setup(w, h) {
  W = w; H = h;
  const s = Math.min(1, 512 / W);
  MW = Math.max(16, Math.round(W * s)); MH = Math.max(16, Math.round(H * s));
  GH = Math.max(8, Math.round(GW * H / W));
  PH = Math.max(8, Math.round(PW * H / W));

  makeCanvas('out', W, H);
  makeCanvas('ml', MW, MH);
  makeCanvas('bg', W, H);
  makeCanvas('tmp', W, H);
  makeCanvas('tmp2', W, H);
  makeCanvas('plate', W, H);
  makeCanvas('cin', W, H);
  makeCanvas('pp', PW, PH, { willReadFrequently: true });
  makeCanvas('ppOut', PW, PH);
  ppImg = C.ppOutCtx.createImageData(PW, PH);
  makeCanvas('gray', 24, 24, { willReadFrequently: true });
  makeCanvas('alive', GW, GH);
  aliveImg = C.aliveCtx.createImageData(GW, GH);
  aliveImg.data.fill(255);
  setupMask(MW, MH);
  bgFrames = 0;

  const g = makeCanvas('grain', 256, 256);
  const gi = g.createImageData(256, 256);
  for (let i = 0; i < gi.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = v; gi.data[i + 3] = 255;
  }
  g.putImageData(gi, 0, 0);
  grainPattern = C.outCtx.createPattern(C.grain, 'repeat');
  if (!billSprites.length) billSprites = [makeBill(['#a9d18e', '#5f8f45']), makeBill(['#b7d9a0', '#6b9a52']), makeBill(['#9cc784', '#557f3d'])];
}

function setupMask(w, h) {
  makeCanvas('mask', w, h);
  makeCanvas('loose', w, h);
  makeCanvas('dmask', w, h);
  makeCanvas('combo', w, h);
  makeCanvas('snap', w, h, { willReadFrequently: true });
  makeCanvas('part', w, h);
  maskImg = C.maskCtx.createImageData(w, h);
  looseImg = C.looseCtx.createImageData(w, h);
  for (const img of [maskImg, looseImg]) {
    img.data.fill(255);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
  }
  partImg = C.partCtx.createImageData(w, h);
  part32 = new Uint32Array(partImg.data.buffer);
}

// ------------------------------------------------------------------ person mask
let personFrac = 0;

function updateMask(m) {
  const w = m.width, h = m.height;
  if (!C.mask || C.mask.width !== w || C.mask.height !== h) setupMask(w, h);
  const f = m.getAsFloat32Array();
  const d = maskImg.data, l = looseImg.data;
  let count = 0;
  for (let i = 0, j = 3; i < f.length; i++, j += 4) {
    const v = f[i];
    const a = v <= 0.3 ? 0 : v >= 0.7 ? 255 : (v - 0.3) * 637.5;
    d[j] = a;
    l[j] = v >= 0.12 ? 255 : v * 2125;   // generous version: hair, edges, shadows
    if (a > 127) count++;
  }
  personFrac = count / f.length;
  C.maskCtx.putImageData(maskImg, 0, 0);
  C.looseCtx.putImageData(looseImg, 0, 0);

  // Grown + softened copy used to cut you out of the picture completely.
  const dm = C.dmaskCtx;
  dm.clearRect(0, 0, w, h);
  dm.filter = `blur(${Math.max(3, w / 45)}px)`;
  for (let k = 0; k < 6; k++) dm.drawImage(C.loose, 0, 0);
  dm.filter = 'none';
}

function clearMask() {
  personFrac = 0;
  for (const img of [maskImg, looseImg]) for (let j = 3; j < img.data.length; j += 4) img.data[j] = 0;
  for (const n of ['mask', 'loose', 'dmask']) C[n + 'Ctx'].clearRect(0, 0, C[n].width, C[n].height);
}

// ------------------------------------------------------------------ background plate
// Continuously remembers what is behind you, so when you vanish the room is still there.
function learnBackground(frame) {
  const t = C.tmpCtx;
  t.globalCompositeOperation = 'copy';
  t.drawImage(frame, 0, 0, W, H);
  t.globalCompositeOperation = 'destination-out';
  t.drawImage(C.dmask, 0, 0, W, H);
  t.drawImage(C.dmask, 0, 0, W, H);
  t.globalCompositeOperation = 'source-over';
  C.bgCtx.globalAlpha = bgFrames < 15 ? 0.5 : 0.18;
  C.bgCtx.drawImage(C.tmp, 0, 0);
  C.bgCtx.globalAlpha = 1;
  bgFrames++;
}

// Fills the never-seen area behind you from the surrounding room (push-pull fill),
// so nothing of you leaks into the empty space.
function buildPlate() {
  const ctx = C.ppCtx;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(C.bg, 0, 0, PW, PH);
  const src = ctx.getImageData(0, 0, PW, PH).data;
  let w = PW, h = PH;
  const n0 = w * h;
  let L = { w, h, R: new Float32Array(n0), G: new Float32Array(n0), B: new Float32Array(n0), A: new Float32Array(n0) };
  for (let i = 0; i < n0; i++) {
    const a = src[i * 4 + 3] / 255;
    L.A[i] = a < 0.15 ? 0 : a; L.R[i] = src[i * 4]; L.G[i] = src[i * 4 + 1]; L.B[i] = src[i * 4 + 2];
  }
  const levels = [L];
  while (w > 1 || h > 1) {
    const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2), n = nw * nh;
    const N = { w: nw, h: nh, R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n), A: new Float32Array(n) };
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sa = 0, sr = 0, sg = 0, sb = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const fx = x * 2 + dx, fy = y * 2 + dy;
        if (fx >= w || fy >= h) continue;
        const i = fy * w + fx, a = L.A[i];
        sa += a; sr += L.R[i] * a; sg += L.G[i] * a; sb += L.B[i] * a;
      }
      const o = y * nw + x;
      if (sa > 0) { N.R[o] = sr / sa; N.G[o] = sg / sa; N.B[o] = sb / sa; }
      N.A[o] = Math.min(1, sa);
    }
    levels.push(N); L = N; w = nw; h = nh;
  }
  for (let k = levels.length - 2; k >= 0; k--) {
    const F = levels[k], Co = levels[k + 1];
    for (let y = 0; y < F.h; y++) for (let x = 0; x < F.w; x++) {
      const i = y * F.w + x, ci = (y >> 1) * Co.w + (x >> 1), a = F.A[i];
      F.R[i] = F.R[i] * a + Co.R[ci] * (1 - a);
      F.G[i] = F.G[i] * a + Co.G[ci] * (1 - a);
      F.B[i] = F.B[i] * a + Co.B[ci] * (1 - a);
      F.A[i] = 1;
    }
  }
  const F = levels[0], d = ppImg.data;
  for (let i = 0; i < n0; i++) { d[i * 4] = F.R[i]; d[i * 4 + 1] = F.G[i]; d[i * 4 + 2] = F.B[i]; d[i * 4 + 3] = 255; }
  C.ppOutCtx.putImageData(ppImg, 0, 0);

  const p = C.plateCtx;
  p.globalCompositeOperation = 'copy';
  p.filter = `blur(${Math.round(W / PW * 2)}px)`;
  p.drawImage(C.ppOut, -4, -4, W + 8, H + 8);
  p.filter = 'none';
  p.globalCompositeOperation = 'source-over';
  p.drawImage(C.bg, 0, 0);
  if (settings.bgBlur) {
    p.globalCompositeOperation = 'copy';
    p.filter = `blur(${blurPx()}px)`;
    p.drawImage(C.plate, 0, 0);
    p.filter = 'none';
    p.globalCompositeOperation = 'source-over';
  }
}

const blurPx = () => Math.max(6, Math.round(W / 70));

// Our own background blur. It runs BEFORE the effects, so cash, memes and
// text stay sharp (Meet's blur runs after us and blurs them).
function drawBase(frame) {
  const o = C.outCtx;
  if (!settings.bgBlur) { o.drawImage(frame, 0, 0, W, H); return; }
  const pad = blurPx() * 2;
  o.filter = `blur(${blurPx()}px)`;
  o.drawImage(frame, -pad, -pad, W + pad * 2, H + pad * 2);
  o.filter = 'none';
  const t = C.tmpCtx;
  t.globalCompositeOperation = 'copy';
  t.drawImage(frame, 0, 0, W, H);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(C.loose, 0, 0, W, H);
  t.globalCompositeOperation = 'source-over';
  o.drawImage(C.tmp, 0, 0);
}

function drawPersonRemoved() {
  const t = C.tmp2Ctx;
  t.globalCompositeOperation = 'copy';
  t.drawImage(C.plate, 0, 0);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(C.dmask, 0, 0, W, H);
  t.globalCompositeOperation = 'source-over';
  C.outCtx.drawImage(C.tmp2, 0, 0);
  C.outCtx.drawImage(C.tmp2, 0, 0); // twice → fully opaque over the soft edge
}

// ------------------------------------------------------------------ noise
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { sum += amp * vnoise(x * f, y * f, s + o * 17); f *= 2.1; amp *= 0.5; }
  return sum / 0.9375;
}

// ------------------------------------------------------------------ dust effect
const D_TOTAL = 4.1;   // seconds for a full dissolve
const RETURN_SPEED = 1.5;
let A = null;          // per-cell time at which that part of you turns to dust
let wind = 1;
let np = 0;
let P = null;

function buildDust(frame) {
  wind = Math.random() < 0.5 ? -1 : 1;
  const seed = (Math.random() * 1e6) | 0;
  A = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const n = fbm(x / GW * 5, y / GW * 8, seed);
      const sweep = wind > 0 ? x / GW : 1 - x / GW;
      const v = Math.min(1, Math.max(0, 0.6 * n + 0.45 * sweep - 0.05));
      A[y * GW + x] = 0.1 + 2.1 * v;
    }
  }

  const mw = C.mask.width, mh = C.mask.height;
  C.snapCtx.drawImage(frame, 0, 0, mw, mh);
  const px = C.snapCtx.getImageData(0, 0, mw, mh).data;
  const md = maskImg.data;
  let candidates = 0;
  for (let j = 3; j < md.length; j += 4) if (md[j] > 140) candidates++;
  const MAXP = 60000;
  const keep = Math.min(1, MAXP / Math.max(1, candidates));

  P = {
    x: new Float32Array(MAXP), y: new Float32Array(MAXP),
    vx: new Float32Array(MAXP), vy: new Float32Array(MAXP),
    act: new Float32Array(MAXP), life: new Float32Array(MAXP), ph: new Float32Array(MAXP),
    r: new Uint8Array(MAXP), g: new Uint8Array(MAXP), b: new Uint8Array(MAXP), big: new Uint8Array(MAXP),
  };
  const sc = mw / 512;
  np = 0;
  for (let y = 0; y < mh && np < MAXP; y++) {
    for (let x = 0; x < mw && np < MAXP; x++) {
      const i = y * mw + x;
      if (md[i * 4 + 3] <= 140 || Math.random() > keep) continue;
      const gx = Math.min(GW - 1, (x / mw * GW) | 0), gy = Math.min(GH - 1, (y / mh * GH) | 0);
      P.x[np] = x; P.y[np] = y;
      P.r[np] = px[i * 4]; P.g[np] = px[i * 4 + 1]; P.b[np] = px[i * 4 + 2];
      P.act[np] = A[gy * GW + gx] + (Math.random() - 0.5) * 0.06;
      P.vx[np] = wind * (20 + 75 * Math.random()) * sc;
      P.vy[np] = -(4 + 38 * Math.random()) * sc;
      P.life[np] = 1.1 + 0.9 * Math.random();
      P.ph[np] = Math.random() * 6.283;
      P.big[np] = Math.random() < 0.12 ? 1 : 0;
      np++;
    }
  }
}

function drawAlivePerson(frame, f) {
  // Parts of you whose time hasn't come yet stay solid (and live).
  const d = aliveImg.data;
  for (let i = 0, j = 3; i < A.length; i++, j += 4) {
    const a = (A[i] - f) * 14;
    d[j] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
  }
  C.aliveCtx.putImageData(aliveImg, 0, 0);
  const mw = C.mask.width, mh = C.mask.height;
  const c = C.comboCtx;
  c.globalCompositeOperation = 'copy';
  c.drawImage(C.loose, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(C.alive, 0, 0, mw, mh);
  c.globalCompositeOperation = 'source-over';

  const t = C.tmpCtx;
  t.globalCompositeOperation = 'copy';
  t.drawImage(frame, 0, 0, W, H);
  t.globalCompositeOperation = 'destination-in';
  t.drawImage(C.combo, 0, 0, W, H);
  t.globalCompositeOperation = 'source-over';
  C.outCtx.drawImage(C.tmp, 0, 0);
}

function drawDust(f) {
  if (!P) return;
  const mw = C.mask.width, mh = C.mask.height;
  part32.fill(0);
  const sc = mw / 512;
  const ax = wind * 55 * sc, ay = -22 * sc, turb = 9 * sc;
  for (let i = 0; i < np; i++) {
    const g = f - P.act[i];
    const life = P.life[i];
    if (g <= 0 || g >= life) continue;
    const g2 = g * g;
    const ph = P.ph[i];
    const x = P.x[i] + P.vx[i] * g + 0.5 * ax * g2 + Math.sin(ph + g * 4.2) * turb * g;
    const y = P.y[i] + P.vy[i] * g + 0.5 * ay * g2 + Math.cos(ph * 1.7 + g * 3.1) * turb * 0.7 * g;
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= mw - 1 || yi >= mh - 1) continue;
    const t = g / life;
    const alpha = (255 * Math.pow(1 - t, 1.25)) | 0;
    const k = Math.min(1, t * 2.2);
    const r = (P.r[i] + (66 - P.r[i]) * k) | 0;
    const gg = (P.g[i] + (58 - P.g[i]) * k) | 0;
    const b = (P.b[i] + (52 - P.b[i]) * k) | 0;
    const col = ((alpha << 24) | (b << 16) | (gg << 8) | r) >>> 0;
    const o = yi * mw + xi;
    part32[o] = col;
    if (P.big[i]) { part32[o + 1] = col; part32[o + mw] = col; part32[o + mw + 1] = col; }
  }
  C.partCtx.putImageData(partImg, 0, 0);
  C.outCtx.imageSmoothingEnabled = true;
  C.outCtx.drawImage(C.part, 0, 0, W, H);
}

// ------------------------------------------------------------------ cash rain
function makeBill(tint) {
  const w = 300, h = 128;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, tint[0]); grd.addColorStop(1, tint[1]);
  g.fillStyle = grd;
  g.beginPath(); g.roundRect(0, 0, w, h, 6); g.fill();
  g.strokeStyle = 'rgba(25,70,25,0.85)'; g.lineWidth = 4; g.strokeRect(9, 9, w - 18, h - 18);
  g.lineWidth = 1.2; g.strokeRect(16, 16, w - 32, h - 32);
  g.strokeStyle = 'rgba(25,70,25,0.18)';
  for (let i = 0; i < 14; i++) { g.beginPath(); g.ellipse(w / 2, h / 2, 34 + i * 8, 20 + i * 3.4, 0, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = 'rgba(238,246,228,0.95)';
  g.beginPath(); g.ellipse(w / 2, h / 2, 36, 44, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(25,70,25,0.9)'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#1e4d1e';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 58px Georgia, serif';
  g.fillText('$', w / 2, h / 2 + 3);
  g.font = '700 24px Georgia, serif';
  g.fillText('100', 44, 34); g.fillText('100', w - 44, 34);
  g.fillText('100', 44, h - 32); g.fillText('100', w - 44, h - 32);
  return c;
}

let bills = [];
let cashSpawnUntil = 0, spawnAcc = 0;
function startCash(now) { cashSpawnUntil = now + 3400; }

function spawnBill() {
  const w = W * (0.1 + 0.07 * Math.random());
  bills.push({
    x: Math.random() * W, y: -w * 0.6 - Math.random() * H * 0.15, w,
    vy: H * (0.2 + 0.2 * Math.random()), sway: W * (0.05 + 0.12 * Math.random()),
    sf: 1.5 + 2 * Math.random(), ph: Math.random() * 6.28,
    rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 2.6,
    flip: 2.5 + 4 * Math.random(), t: 0,
    sprite: billSprites[(Math.random() * billSprites.length) | 0],
  });
}

function updateCash(now, dt) {
  if (now < cashSpawnUntil) {
    spawnAcc += dt * 30;
    while (spawnAcc >= 1) { spawnAcc -= 1; spawnBill(); }
  }
  for (const b of bills) {
    b.t += dt;
    b.y += b.vy * dt;
    b.x += Math.sin(b.t * b.sf + b.ph) * b.sway * dt;
    b.rot += b.vr * dt;
  }
  bills = bills.filter((b) => b.y < H + b.w);
}

function drawCash() {
  const o = C.outCtx;
  for (const b of bills) {
    const fl = Math.cos(b.t * b.flip + b.ph);
    const sy = Math.sign(fl || 1) * Math.max(0.12, Math.abs(fl));
    const h = b.w * 128 / 300;
    o.save();
    o.translate(b.x, b.y);
    o.rotate(b.rot);
    o.scale(1, sy);
    o.shadowColor = 'rgba(0,0,0,0.35)'; o.shadowBlur = b.w * 0.06; o.shadowOffsetY = b.w * 0.03;
    o.drawImage(b.sprite, -b.w / 2, -h / 2, b.w, h);
    o.shadowColor = 'transparent';
    if (fl < 0) { o.fillStyle = 'rgba(0,30,0,0.2)'; o.fillRect(-b.w / 2, -h / 2, b.w, h); }
    o.restore();
  }
}

// ------------------------------------------------------------------ state
let state = 'visible'; // visible | dissolving | gone | returning
let tStart = 0;
let lastSnapT = -1e9;
let pendingSnapT = -1;
let snapNow = false;
let lastAudioSpike = -1e9;

function onSnapEvent(now) {
  // With cash rain on, wait briefly to see if a second snap follows.
  if (settings.cash !== false) {
    if (pendingSnapT > 0 && now - pendingSnapT < 900) {
      pendingSnapT = -1;
      startCash(now);
      lastSnapT = now;
      return;
    }
    pendingSnapT = now;
  } else {
    snapNow = true;
  }
}

function startSnap(frame, now) {
  if (settings.snap === false) return;
  if (now - lastSnapT < 1200) return;
  if (state === 'visible') {
    buildDust(frame);
    state = 'dissolving'; tStart = now; lastSnapT = now;
    cinemaManual = false; cinemaOn = false;
  } else if (state === 'gone') {
    buildDust(frame);
    state = 'returning'; tStart = now; lastSnapT = now;
  }
}

function effectTime(now) {
  const el = (now - tStart) / 1000;
  if (state === 'dissolving') return el;
  if (state === 'returning') return D_TOTAL - el * RETURN_SPEED;
  return D_TOTAL;
}

function advanceState(now) {
  const el = (now - tStart) / 1000;
  if (state === 'dissolving' && el >= D_TOTAL) { state = 'gone'; P = null; }
  if (state === 'returning' && el * RETURN_SPEED >= D_TOTAL) { state = 'visible'; P = null; A = null; }
}

// ------------------------------------------------------------------ gestures
const handState = {};
const dbg = { hands: [], snapInfo: '', cinemaInfo: '' };

function lmDist(lm, a, b) {
  const dx = (lm[a].x - lm[b].x) * W, dy = (lm[a].y - lm[b].y) * H;
  return Math.hypot(dx, dy);
}

function detectSnap(hr, now) {
  const sens = SENS[settings.sensitivity] || SENS.normal;
  let fired = false;
  dbg.hands = hr.landmarks || [];
  const infos = [];
  const seen = new Set();
  (hr.landmarks || []).forEach((lm, i) => {
    const label = (hr.handedness && hr.handedness[i] && hr.handedness[i][0] && hr.handedness[i][0].categoryName) || String(i);
    seen.add(label);
    const hs = handState[label] || (handState[label] = { frames: 0, lastPinch: -1e9, d12: 0, lastSeen: now });
    hs.lastSeen = now;
    const sc = lmDist(lm, 0, 9);
    if (sc < 4) return;
    const dTM = lmDist(lm, 4, 12) / sc;   // thumb tip ↔ middle tip
    const d12w = lmDist(lm, 12, 0) / sc;  // middle tip ↔ wrist
    infos.push(`${label[0]} tm=${dTM.toFixed(2)} mw=${d12w.toFixed(2)}${hs.frames >= 2 ? ' armed' : ''}`);

    if (dTM < sens.pinch) {
      hs.frames++; hs.lastPinch = now; hs.d12 = d12w;
    } else {
      const recent = now - hs.lastPinch < 380;
      const released = dTM > sens.pinch + 0.22;
      const curled = d12w < hs.d12 - sens.curl;
      const heard = now - lastAudioSpike < 350;
      if (hs.frames >= 2 && recent && released && (curled || heard)) {
        fired = true; hs.frames = 0;
      }
      if (!recent) hs.frames = 0;
    }
  });
  for (const [label, hs] of Object.entries(handState)) {
    if (!seen.has(label) && hs.frames >= 2 && now - hs.lastPinch < 500 && now - lastAudioSpike < 350) {
      fired = true; hs.frames = 0;
    }
    if (now - hs.lastSeen > 2000) delete handState[label];
  }
  dbg.snapInfo = infos.join('  |  ');
  return fired;
}

let cinemaOn = false, cinemaManual = false, condSince = 0, lastCond = -1e9, cinemaC = 0, cinemaShownAt = 0;

// ---- facepalm: a hand over your eyes/forehead
let palmOn = false, palmSince = 0, palmLast = -1e9, palmC = 0, palmManual = false, lastPoseLm = null;

function facepalmCond(hr) {
  const pl = lastPoseLm;
  if (!pl || !hr.landmarks || !hr.landmarks.length) return false;
  const ex = (pl[2].x + pl[5].x) / 2 * W, ey = (pl[2].y + pl[5].y) / 2 * H;
  const ed = Math.max(Math.hypot((pl[2].x - pl[5].x) * W, (pl[2].y - pl[5].y) * H),
    Math.hypot((pl[7].x - pl[8].x) * W, (pl[7].y - pl[8].y) * H) * 0.45);
  if (ed < 3) return false;
  for (const lm of hr.landmarks) {
    let near = 0;
    for (const t of [8, 12, 16]) if (Math.hypot(lm[t].x * W - ex, lm[t].y * H - ey) < ed * 2.4) near++;
    const px = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].x, 0) / 5 * W;
    const py = [0, 5, 9, 13, 17].reduce((s, i) => s + lm[i].y, 0) / 5 * H;
    const dp = Math.hypot(px - ex, py - ey);
    const sc = lmDist(lm, 0, 9);
    if (near >= 2 && dp < ed * 3.6 && sc > ed * 0.7) return true;
  }
  return false;
}

function updateFacepalm(hr, now, dt, cinemaTarget) {
  const cond = settings.facepalm !== false && state === 'visible' && !cinemaTarget && facepalmCond(hr);
  if (cond) {
    if (!palmSince) palmSince = now;
    if (now - palmSince > 400) palmOn = true;
    palmLast = now;
  } else {
    palmSince = 0;
    if (palmOn && now - palmLast > 900) palmOn = false;
  }
  const target = (palmOn || palmManual) && palmBmp && state === 'visible' ? 1 : 0;
  const rate = target ? 5 : 3;
  palmC += Math.sign(target - palmC) * Math.min(Math.abs(target - palmC), dt * rate);
  dbg.palmInfo = cond ? 'facepalm!' : '';
}

function drawPalmMeme(c) {
  const o = C.outCtx;
  const mw = palmBmp.width, mh = palmBmp.height;
  const s = Math.max(W / mw, H / mh);
  o.globalAlpha = c * PALM_OPACITY;
  o.drawImage(palmBmp, (W - mw * s) / 2, (H - mh * s) / 2, mw * s, mh * s);
  o.globalAlpha = 1;
}

function handsUpByPose(lm) {
  if (!lm) return false;
  const v = (i) => (lm[i].visibility === undefined ? 1 : lm[i].visibility);
  if (v(11) < 0.4 || v(12) < 0.4 || v(15) < 0.3 || v(16) < 0.3) return false;
  const sw = Math.abs(lm[11].x - lm[12].x) * W;
  if (sw < 10) return false;
  const up = (lm[15].y - lm[11].y) * H < -0.12 * sw && (lm[16].y - lm[12].y) * H < -0.12 * sw;
  const wide = Math.abs(lm[15].x - lm[16].x) * W > 0.95 * sw;
  return up && wide;
}

function handsUpByHands(hr) {
  const L = hr.landmarks || [];
  if (L.length < 2) return false;
  const ok = L.map((lm) => {
    const sc = lmDist(lm, 0, 9);
    if (sc < 4) return null;
    const open = [8, 12, 16, 20].filter((t) => lmDist(lm, t, 0) > lmDist(lm, t - 2, 0) * 1.08).length >= 3;
    const upright = (lm[12].y - lm[0].y) * H < -0.9 * sc;
    const high = lm[0].y < 0.85;
    return open && upright && high ? lm[0].x : null;
  });
  if (ok[0] === null || ok[1] === null) return false;
  return Math.abs(ok[0] - ok[1]) > 0.32;
}

function updateCinema(hr, poseLm, now, dt) {
  const cond = settings.cinema && (handsUpByPose(poseLm) || handsUpByHands(hr));
  dbg.cinemaInfo = cond ? 'hands up!' : '';
  if (cond) {
    if (!condSince) condSince = now;
    if (now - condSince > 280) cinemaOn = true;
    lastCond = now;
  } else {
    condSince = 0;
    if (cinemaOn && now - lastCond > 1100) cinemaOn = false;
  }
  const target = (cinemaOn || cinemaManual) && state === 'visible' && settings.cinema ? 1 : 0;
  if (target && cinemaC < 0.01) cinemaShownAt = now;
  const rate = target ? 5 : 3;
  cinemaC += Math.sign(target - cinemaC) * Math.min(Math.abs(target - cinemaC), dt * rate);
  return target;
}

// ------------------------------------------------------------------ cinema overlay
function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }

let liveFace = null, liveFaceT = 0, liveGray = 0.5, grayFrame = 0;

// Average brightness inside a face (used to match your face to the meme).
function sampleGray(src, face, sw, sh) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of face.oval) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const bw = (x1 - x0) * sw * 0.6, bh = (y1 - y0) * sh * 0.6;
  if (bw < 2 || bh < 2) return 0.5;
  const g = C.grayCtx || makeCanvas('gray', 24, 24, { willReadFrequently: true });
  g.drawImage(src, (x0 + x1) / 2 * sw - bw / 2, (y0 + y1) / 2 * sh - bh / 2, bw, bh, 0, 0, 24, 24);
  const d = g.getImageData(0, 0, 24, 24).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return s / (d.length / 4) / 255;
}

// Your own face placed into the meme picture, following your head live.
function drawMemeSwap(frame, c) {
  const ci = C.cinCtx;
  const mw = memeBmp.width, mh = memeBmp.height;
  ci.setTransform(1, 0, 0, 1, 0, 0);
  ci.globalCompositeOperation = 'source-over';
  const cs = Math.max(W / mw, H / mh);
  ci.filter = 'blur(28px) brightness(0.5)';
  ci.drawImage(memeBmp, (W - mw * cs) / 2, (H - mh * cs) / 2, mw * cs, mh * cs);
  ci.filter = 'none';
  const s = Math.min(W / mw, H / mh);
  const dw = mw * s, dh = mh * s, dx = (W - dw) / 2, dy = (H - dh) / 2;
  ci.drawImage(memeBmp, dx, dy, dw, dh);

  if (liveFace && memeFace) {
    const p1 = { x: liveFace.e1.x * W, y: liveFace.e1.y * H }, p2 = { x: liveFace.e2.x * W, y: liveFace.e2.y * H };
    const q1 = { x: dx + memeFace.e1.x * dw, y: dy + memeFace.e1.y * dh }, q2 = { x: dx + memeFace.e2.x * dw, y: dy + memeFace.e2.y * dh };
    const lu = Math.hypot(p2.x - p1.x, p2.y - p1.y), lm = Math.hypot(q2.x - q1.x, q2.y - q1.y);
    if (lu > 2) {
      const sc = (lm / lu) * 1.04;
      const ang = Math.atan2(q2.y - q1.y, q2.x - q1.x) - Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const a = sc * Math.cos(ang), b = sc * Math.sin(ang), cc = -b, d = a;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const qx = (q1.x + q2.x) / 2, qy = (q1.y + q2.y) / 2;
      const e = qx - (a * mx + cc * my), f = qy - (b * mx + d * my);

      const bright = Math.min(1.6, Math.max(0.6, (memeFace.gray || 0.5) / Math.max(0.05, liveGray)));
      const t = C.tmpCtx;
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = 'source-over';
      t.clearRect(0, 0, W, H);
      t.setTransform(a, b, cc, d, e, f);
      t.filter = `grayscale(1) contrast(1.25) brightness(${bright.toFixed(2)})`;
      t.drawImage(frame, 0, 0, W, H);
      t.filter = 'none';

      // soft-edged face shape
      const m = C.tmp2Ctx;
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.clearRect(0, 0, W, H);
      m.filter = `blur(${Math.max(2, lm * 0.16).toFixed(1)}px)`;
      m.setTransform(a, b, cc, d, e, f);
      let cx = 0, cy = 0;
      for (const p of liveFace.oval) { cx += p.x; cy += p.y; }
      cx = cx / liveFace.oval.length * W; cy = cy / liveFace.oval.length * H;
      m.beginPath();
      liveFace.oval.forEach((p, i) => {
        const x = cx + (p.x * W - cx) * 0.96, y = cy + (p.y * H - cy) * 0.96;
        i ? m.lineTo(x, y) : m.moveTo(x, y);
      });
      m.closePath();
      m.fillStyle = '#fff';
      m.fill();
      m.filter = 'none';
      m.setTransform(1, 0, 0, 1, 0, 0);

      t.setTransform(1, 0, 0, 1, 0, 0);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(C.tmp2, 0, 0);
      t.globalCompositeOperation = 'source-over';
      ci.drawImage(C.tmp, 0, 0);
    }
  }

  // slight grain so the face blends into the photo
  ci.globalCompositeOperation = 'overlay';
  ci.globalAlpha = 0.12;
  ci.fillStyle = grainPattern;
  ci.fillRect(0, 0, W, H);
  ci.globalAlpha = 1;
  ci.globalCompositeOperation = 'source-over';

  const o = C.outCtx;
  o.globalAlpha = c;
  o.drawImage(C.cin, 0, 0);
  o.globalAlpha = 1;
}

function drawCinema(c, now) {
  const o = C.outCtx;
  const e = 1 - Math.pow(1 - c, 3);

  const ci = C.cinCtx;
  ci.setTransform(1, 0, 0, 1, 0, 0);
  ci.globalCompositeOperation = 'copy';
  ci.filter = 'grayscale(1) contrast(1.35) brightness(0.96)';
  ci.drawImage(C.out, 0, 0);
  ci.filter = 'none';
  ci.globalCompositeOperation = 'source-over';
  o.globalAlpha = c;
  o.drawImage(C.cin, 0, 0);

  const g = o.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.hypot(W, H) * 0.55);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.65)');
  o.fillStyle = g;
  o.fillRect(0, 0, W, H);

  o.globalCompositeOperation = 'overlay';
  o.globalAlpha = 0.2 * c;
  o.save();
  o.translate((Math.random() * 256) | 0, (Math.random() * 256) | 0);
  o.fillStyle = grainPattern;
  o.fillRect(-256, -256, W + 512, H + 512);
  o.restore();
  o.globalCompositeOperation = 'source-over';
  o.globalAlpha = 0.04 * c * Math.random();
  o.fillStyle = '#000';
  o.fillRect(0, 0, W, H);
  o.globalAlpha = 1;

  const barH = H * 0.075 * e;
  o.fillStyle = '#000';
  o.fillRect(0, 0, W, barH);
  o.fillRect(0, H - barH, W, barH);

  const since = (now - cinemaShownAt) / 1000;

  // A meme picture without a detectable face: show it as a card beside you.
  if (memeBmp) {
    const pop = Math.min(1, Math.max(0, (since - 0.15) / 0.45));
    if (pop > 0) {
      const s = easeOutBack(pop);
      const mh = H * 0.36, mw = mh * memeBmp.width / memeBmp.height;
      const x = W - mw / 2 - W * 0.035, y = barH + H * 0.035 + mh / 2;
      o.save();
      o.globalAlpha = Math.min(1, pop * 1.5) * c;
      o.translate(x, y);
      o.rotate(-0.045);
      o.scale(s, s);
      o.fillStyle = '#fff';
      o.shadowColor = 'rgba(0,0,0,0.6)'; o.shadowBlur = 18;
      const pad = Math.max(3, H * 0.006);
      o.fillRect(-mw / 2 - pad, -mh / 2 - pad, mw + pad * 2, mh + pad * 2);
      o.shadowBlur = 0;
      o.drawImage(memeBmp, -mw / 2, -mh / 2, mw, mh);
      o.restore();
    }
  }

  if (settings.showText !== false) {
    const t = Math.min(1, Math.max(0, (since - 0.05) / 0.5));
    if (t > 0) {
      const fs = Math.round(H * 0.1);
      o.save();
      o.globalAlpha = Math.min(1, t * 1.4) * c;
      o.translate(W / 2, H - barH - H * 0.07);
      const s = 1 + 0.35 * Math.pow(1 - t, 3);
      o.scale(s, s);
      o.font = `700 ${fs}px "Times New Roman", Times, Georgia, serif`;
      try { o.letterSpacing = `${Math.round(fs * 0.07)}px`; } catch (_) {}
      o.textAlign = 'center';
      o.textBaseline = 'alphabetic';
      o.shadowColor = 'rgba(0,0,0,0.85)';
      o.shadowBlur = fs * 0.25;
      o.fillStyle = '#fff';
      o.fillText('ABSOLUTE CINEMA', 0, 0);
      o.restore();
    }
  }
}

// ------------------------------------------------------------------ debug HUD
function drawDebug(fps) {
  const o = C.outCtx;
  o.save();
  o.fillStyle = '#00e5ff';
  for (const lm of dbg.hands) {
    for (const p of lm) o.fillRect(p.x * W - 3, p.y * H - 3, 6, 6);
    o.fillStyle = '#ff3d71';
    for (const k of [4, 12]) o.fillRect(lm[k].x * W - 6, lm[k].y * H - 6, 12, 12);
    o.fillStyle = '#00e5ff';
  }
  const fs = Math.max(12, Math.round(H * 0.028));
  o.font = `600 ${fs}px monospace`;
  o.textAlign = 'left';
  const lines = [
    `state: ${state}   fps: ${fps.toFixed(0)}   person: ${(personFrac * 100).toFixed(0)}%   bg: ${Math.min(100, bgFrames)}`,
    dbg.snapInfo || 'no hands',
    `${dbg.cinemaInfo} ${dbg.palmInfo || ''}  meme face: ${memeBmp ? (memeFace ? 'found' : 'not found') : 'no meme'}  your face: ${liveFace ? 'tracked' : '-'}`,
  ];
  o.fillStyle = 'rgba(0,0,0,0.55)';
  o.fillRect(8, 8, W * 0.75, lines.length * fs * 1.4 + 10);
  o.fillStyle = '#fff';
  lines.forEach((l, i) => o.fillText(l, 16, 10 + fs * 1.2 * (i + 1)));
  o.restore();
}

// ------------------------------------------------------------------ frame loop
let lastTs = 0, lastT = performance.now(), frameNo = 0, fps = 30;
let keySnap = false, keyCash = false;

function processFrame(id, bmp) {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  fps = fps * 0.9 + (dt > 0 ? 1 / dt : 30) * 0.1;
  frameNo++;

  if (!ready || settings.enabled === false) {
    post({ type: 'result', id, bitmap: bmp }, [bmp]);
    return;
  }
  if (bmp.width !== W || bmp.height !== H) {
    setup(bmp.width, bmp.height);
    if (memeFace && memeBmp) memeFace.gray = sampleGray(memeBmp, memeFace, memeBmp.width, memeBmp.height);
  }

  C.mlCtx.drawImage(bmp, 0, 0, MW, MH);
  const ts = Math.max(now, lastTs + 1);
  lastTs = ts;

  const hr = hand.detectForVideo(C.ml, ts);

  let poseLm = null;
  if (state !== 'visible' || frameNo % 2 === 0 || bgFrames < 15 || pendingSnapT > 0 || settings.bgBlur) {
    const pr = pose.detectForVideo(C.ml, ts);
    poseLm = pr.landmarks && pr.landmarks[0];
    lastPoseLm = poseLm || null;
    const masks = pr.segmentationMasks || [];
    if (masks.length) updateMask(masks[0]); else clearMask();
    masks.forEach((m) => m.close && m.close());
    learnBackground(bmp);
  }

  if (detectSnap(hr, now)) onSnapEvent(now);
  if (keySnap) { keySnap = false; snapNow = true; }
  if (keyCash) { keyCash = false; startCash(now); }
  if (pendingSnapT > 0 && now - pendingSnapT >= 900) { pendingSnapT = -1; snapNow = true; }
  if (snapNow) { snapNow = false; startSnap(bmp, now); }

  const cinemaTarget = updateCinema(hr, poseLm, now, dt);
  updateFacepalm(hr, now, dt, cinemaTarget);
  advanceState(now);
  updateCash(now, dt);

  // Face tracking only while the meme face-swap is showing.
  const swap = memeBmp && memeFace;
  if (swap && (cinemaTarget || cinemaC > 0.001)) {
    const fr = faceLive.detectForVideo(C.ml, ts);
    const lm = fr.faceLandmarks && fr.faceLandmarks[0];
    if (lm) {
      liveFace = faceKeyPoints(lm); liveFaceT = now;
      if (grayFrame++ % 8 === 0) liveGray = sampleGray(C.ml, liveFace, MW, MH);
    } else if (now - liveFaceT > 600) liveFace = null;
  }

  const active = state !== 'visible' || cinemaC > 0.001 || palmC > 0.001 || bills.length || settings.debug || settings.bgBlur;
  if (!active) {
    post({ type: 'result', id, bitmap: bmp }, [bmp]);
    return;
  }

  const o = C.outCtx;
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalAlpha = 1;
  o.globalCompositeOperation = 'source-over';
  drawBase(bmp);

  if (state !== 'visible') {
    buildPlate();
    drawPersonRemoved();
    if (state === 'dissolving' || state === 'returning') {
      const f = effectTime(now);
      drawAlivePerson(bmp, f);
      drawDust(f);
    }
  }
  if (cinemaC > 0.001) {
    if (swap) drawMemeSwap(bmp, cinemaC);
    else drawCinema(cinemaC, now);
  }
  if (palmC > 0.001 && palmBmp) drawPalmMeme(palmC);
  if (bills.length) drawCash();
  if (settings.debug) drawDebug(fps);

  bmp.close();
  const res = C.out.transferToImageBitmap();
  post({ type: 'result', id, bitmap: res }, [res]);
}

let errCount = 0;
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d || d.__snapfx !== 1) return;
  if (d.type === 'frame') {
    try {
      processFrame(d.id, d.bitmap);
    } catch (err) {
      if (errCount++ < 5) console.error('[Snap&Cinema FX]', err);
      try { post({ type: 'result', id: d.id, bitmap: d.bitmap }, [d.bitmap]); }
      catch (_) { post({ type: 'result', id: d.id }); }
    }
  } else if (d.type === 'key') {
    if (d.action === 'snap') keySnap = true;
    if (d.action === 'cinema') cinemaManual = !cinemaManual;
    if (d.action === 'cash') keyCash = true;
    if (d.action === 'facepalm') palmManual = !palmManual;
  } else if (d.type === 'audioSpike') {
    lastAudioSpike = performance.now();
  }
});

init();
