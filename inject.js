// Runs in the page's own JS world at document_start.
// Wraps navigator.mediaDevices.getUserMedia so the camera track the site
// receives is routed through the effects engine (hidden extension iframe).
// Everyone on the call sees the effects, and so do you in your self-view.
(() => {
  if (window.__snapfxInstalled) return;
  window.__snapfxInstalled = true;
  if (typeof MediaDevices === 'undefined' || !MediaDevices.prototype.getUserMedia) return;

  const TAG = '[Snap&Cinema FX]';
  const origGUM = MediaDevices.prototype.getUserMedia;

  // ---------------------------------------------------------------- engine link
  let engineWin = null;
  let engineReady = false;
  let engineActive = true; // engine tells us when effects are switched off
  let requested = false;
  const pending = new Map();
  let nextId = 1;

  function engineFrame() {
    return document.getElementById('snapfx-engine-frame');
  }

  function requestEngine() {
    if (requested && engineFrame()) return;
    requested = true;
    document.dispatchEvent(new CustomEvent('snapfx:need-engine'));
  }

  window.addEventListener('message', (e) => {
    const f = engineFrame();
    if (!f || e.source !== f.contentWindow) return;
    const d = e.data;
    if (!d || d.__snapfx !== 1) return;
    engineWin = f.contentWindow;
    if (d.type === 'ready') {
      engineReady = true;
      console.info(TAG, 'effects engine ready');
    } else if (d.type === 'active') {
      engineActive = !!d.value;
    } else if (d.type === 'result') {
      const cb = pending.get(d.id);
      if (cb) { pending.delete(d.id); cb(d.bitmap || null); }
      else if (d.bitmap) d.bitmap.close();
    } else if (d.type === 'error') {
      console.warn(TAG, d.message);
    }
  });

  function toEngine(msg, transfer) {
    if (engineWin) engineWin.postMessage(Object.assign({ __snapfx: 1 }, msg), '*', transfer || []);
  }

  function processBitmap(bmp) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 300);
      pending.set(id, (b) => { clearTimeout(timer); resolve(b); });
      toEngine({ type: 'frame', id, bitmap: bmp }, [bmp]);
    });
  }

  const canUseEngine = () => engineReady && engineActive && engineWin;

  // Keyboard fallbacks: Alt+Shift+S = snap, Alt+Shift+C = cinema
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyS') { toEngine({ type: 'key', action: 'snap' }); e.preventDefault(); }
    if (e.code === 'KeyC') { toEngine({ type: 'key', action: 'cinema' }); e.preventDefault(); }
    if (e.code === 'KeyM') { toEngine({ type: 'key', action: 'cash' }); e.preventDefault(); }
    if (e.code === 'KeyF') { toEngine({ type: 'key', action: 'facepalm' }); e.preventDefault(); }
  }, true);

  // ------------------------------------------------------------- track wrapping
  const ourTracks = new WeakSet();
  const origClone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    const c = origClone.call(this);
    if (ourTracks.has(this)) ourTracks.add(c);
    return c;
  };

  function dressTrack(out, src, onStop) {
    // Make the processed track look like the real camera to the site.
    for (const name of ['getSettings', 'getCapabilities', 'getConstraints']) {
      try { out[name] = () => src[name](); } catch (e) {}
    }
    try { out.applyConstraints = (c) => src.applyConstraints(c); } catch (e) {}
    try { Object.defineProperty(out, 'label', { get: () => src.label, configurable: true }); } catch (e) {}
    try { Object.defineProperty(out, 'contentHint', { get: () => src.contentHint, set: (v) => { src.contentHint = v; }, configurable: true }); } catch (e) {}
    const realStop = out.stop.bind(out);
    out.stop = () => { onStop(); try { realStop(); } catch (e) {} try { src.stop(); } catch (e) {} };
    src.addEventListener('ended', () => { onStop(); try { realStop(); } catch (e) {} });
    return out;
  }

  function wrapWithInsertableStreams(src) {
    const processor = new MediaStreamTrackProcessor({ track: src, maxBufferSize: 1 });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    let stopped = false;

    (async () => {
      while (!stopped) {
        let r;
        try { r = await reader.read(); } catch (e) { break; }
        if (r.done) break;
        const frame = r.value;
        let out = frame;
        if (canUseEngine()) {
          try {
            const bmp = await createImageBitmap(frame);
            const res = await processBitmap(bmp);
            if (res) {
              out = new VideoFrame(res, { timestamp: frame.timestamp });
              res.close();
              frame.close();
            }
          } catch (e) { out = frame; }
        }
        try { await writer.write(out); } catch (e) { try { out.close(); } catch (_) {} break; }
      }
      try { reader.cancel(); } catch (e) {}
    })();

    return dressTrack(generator, src, () => { stopped = true; });
  }

  function wrapWithCanvas(src) {
    // Fallback for browsers without insertable streams.
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream([src]);
    video.play().catch(() => {});
    const s = src.getSettings();
    const canvas = document.createElement('canvas');
    canvas.width = s.width || 640; canvas.height = s.height || 480;
    const ctx = canvas.getContext('2d');
    const outStream = canvas.captureStream(s.frameRate || 30);
    const out = outStream.getVideoTracks()[0];
    let stopped = false, busy = false;

    const tick = async () => {
      if (stopped) return;
      if (!busy && video.videoWidth) {
        busy = true;
        if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
        let drawn = false;
        if (canUseEngine()) {
          try {
            const res = await processBitmap(await createImageBitmap(video));
            if (res) { ctx.drawImage(res, 0, 0, canvas.width, canvas.height); res.close(); drawn = true; }
          } catch (e) {}
        }
        if (!drawn) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        busy = false;
      }
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
      else setTimeout(tick, 33);
    };
    tick();
    return dressTrack(out, src, () => { stopped = true; video.srcObject = null; });
  }

  function wrapVideoTrack(src) {
    requestEngine();
    const out = (typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined')
      ? wrapWithInsertableStreams(src) : wrapWithCanvas(src);
    ourTracks.add(out);
    startMirrorFix();
    return out;
  }

  // -------------------------------------------- un-mirror your own self-view
  // Call sites flip your self-view like a mirror, which makes on-screen text
  // read backwards for you. We cancel that flip on videos showing our track,
  // so you see exactly what everyone else sees.
  let mirrorTimer = 0;
  function isMirrored(el) {
    let sign = 1;
    for (; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.transform && cs.transform !== 'none') {
        try { if (new DOMMatrixReadOnly(cs.transform).a < 0) sign = -sign; } catch (e) {}
      }
      if (cs.scale && cs.scale !== 'none' && cs.scale.trim().startsWith('-')) sign = -sign;
    }
    return sign < 0;
  }
  function fixMirrors() {
    const want = document.documentElement.getAttribute('data-snapfx-unmirror') !== '0';
    for (const v of document.querySelectorAll('video')) {
      const so = v.srcObject;
      const ours = want && so && typeof so.getVideoTracks === 'function' && so.getVideoTracks().some((t) => ourTracks.has(t));
      const flipped = v.hasAttribute('data-snapfx-flip');
      if (!ours) {
        if (flipped) { v.style.removeProperty('scale'); v.removeAttribute('data-snapfx-flip'); }
        continue;
      }
      if (isMirrored(v)) {
        if (flipped) { v.style.removeProperty('scale'); v.removeAttribute('data-snapfx-flip'); }
        else { v.style.setProperty('scale', '-1 1', 'important'); v.setAttribute('data-snapfx-flip', ''); }
      }
    }
  }
  function startMirrorFix() {
    if (!mirrorTimer) mirrorTimer = setInterval(fixMirrors, 600);
  }

  // ------------------------------------------------- snap sound detection (mic)
  // Only analysed locally to help confirm a finger snap. Never recorded or sent.
  let audioCtx = null;
  let lastSpike = 0;
  function tapAudio(track) {
    try {
      audioCtx = audioCtx || new AudioContext();
      const clone = track.clone();
      const node = audioCtx.createMediaStreamSource(new MediaStream([clone]));
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1800;
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      node.connect(hp); hp.connect(an);
      const buf = new Float32Array(an.fftSize);
      let avg = 0.003;
      const iv = setInterval(() => {
        if (track.readyState === 'ended') { clearInterval(iv); clone.stop(); return; }
        if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); return; }
        if (!track.enabled) return;
        an.getFloatTimeDomainData(buf);
        let peak = 0, sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (peak > 0.07 && rms > avg * 5 && now - lastSpike > 300) {
          lastSpike = now;
          toEngine({ type: 'audioSpike' });
        }
        avg = avg * 0.94 + rms * 0.06;
      }, 12);
    } catch (e) { /* audio is optional */ }
  }

  // --------------------------------------------------------------- the patch
  const enabled = () => document.documentElement.getAttribute('data-snapfx-enabled') !== '0';

  async function patchedGetUserMedia(constraints) {
    const stream = await origGUM.call(this, constraints);
    try {
      if (!enabled()) return stream;
      const audio = stream.getAudioTracks();
      audio.forEach(tapAudio);
      const videos = stream.getVideoTracks();
      if (!videos.length) return stream;
      const out = wrapVideoTrack(videos[0]);
      return new MediaStream([out, ...audio]);
    } catch (e) {
      console.warn(TAG, 'could not apply effects, using normal camera', e);
      return stream;
    }
  }

  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
    value: patchedGetUserMedia, writable: true, configurable: true,
  });
})();
