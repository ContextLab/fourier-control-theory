// Freehand draw capture + 3Blue1Brown-style epicycle reconstruction animation.
import { setupCanvas, makeTransform, cssVar } from './canvas.js';
import { resampleArcLength, dft, idftEval, fromCoeff } from '../core/fourier.js';
import { jointPositions } from '../core/arm.js';

const PALETTE = ['#267aba', '#ffa00f', '#a5d75f', '#8a6996', '#d94415', '#f5dc69', '#c4dd88', '#9d162e'];
const RESAMPLE_N = 512;
export const K_MIN = 1;
// K counts ROTATING (non-DC) components only; the DC term (if any) is always
// included on top of that, so the true ceiling is one less than the total
// number of DFT bins.
export const K_MAX = RESAMPLE_N - 1;
const TRAIL_POINTS = 240;
// A finished stroke shorter than this (in points, or in pixel bounding-box
// extent) is treated as an accidental tap/click rather than a real drawing:
// resampling/DFT-ing it would either be meaningless or (for a single
// duplicate point) degenerate, so it's rejected with a hint instead of
// silently producing a near-invisible dot.
const MIN_STROKE_POINTS = 5;
const MIN_STROKE_EXTENT_PX = 12;

function paletteColor(i) {
  return PALETTE[i % PALETTE.length];
}

/** Maps a slider position in [min,max] to a log-spaced K in [K_MIN,K_MAX]. */
export function sliderToK(pos, min, max) {
  const t = max > min ? Math.max(0, Math.min(1, (pos - min) / (max - min))) : 0;
  const k = Math.round(Math.exp(Math.log(K_MIN) + t * (Math.log(K_MAX) - Math.log(K_MIN))));
  return Math.min(K_MAX, Math.max(K_MIN, k));
}

/**
 * Like core/fourier.js's topK, but K counts only the ROTATING (non-DC)
 * components; the DC term (if present) is always kept on top of that. This
 * is what makes K=1 render as one spinning epicycle instead of a single
 * motionless dot (plain topK(coeffs, 1) would spend that one slot on DC).
 * @param {Array<{freq:number, c:{re:number,im:number}}>} coeffs
 * @param {number} K
 */
function topKWithDC(coeffs, K) {
  const dc = coeffs.filter((entry) => entry.freq === 0);
  const rest = coeffs
    .filter((entry) => entry.freq !== 0)
    .slice()
    .sort((a, b) => Math.hypot(b.c.re, b.c.im) - Math.hypot(a.c.re, a.c.im));
  return [...dc, ...rest.slice(0, Math.max(0, K))];
}

/**
 * Standard parametric heart curve, used as the pre-loaded example drawing.
 * Same formula (and orientation: y-up, no flip) as the Arm view's "heart"
 * preset (js/core/presets.js heartPath) — lobes up, point down.
 */
function heartRawPoints(n = 300) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push({ x, y });
  }
  return pts;
}

function normalizePoints(pts) {
  let maxAbs = 0;
  for (const p of pts) maxAbs = Math.max(maxAbs, Math.hypot(p.x, p.y));
  if (maxAbs < 1e-9) maxAbs = 1;
  return pts.map((p) => ({ x: p.x / maxAbs, y: p.y / maxAbs }));
}

function computeCoeffs(rawPts) {
  const resampled = resampleArcLength(rawPts, RESAMPLE_N, true);
  return { resampled, coeffs: dft(resampled) };
}

/**
 * @param {HTMLCanvasElement} canvas - #draw-canvas
 * @param {ReturnType<typeof import('../core/store.js').createStore>} store
 * @returns {{render: (state: object) => void, resize: () => void, destroy: () => void}}
 */
export function createDrawView(canvas, store) {
  const canvasState = setupCanvas(canvas);

  const hintEl = document.getElementById('draw-hint');
  const drawStartBtn = document.getElementById('draw-start');
  const drawClearBtn = document.getElementById('draw-clear');
  const drawPlayBtn = document.getElementById('draw-play');
  const kSlider = document.getElementById('k-slider');
  const kValueEl = document.getElementById('k-value');
  const rmsEl = document.getElementById('rms-readout');
  const followTipEl = document.getElementById('follow-tip');
  const sendToArmBtn = document.getElementById('send-to-arm');

  // Whether a stroke is currently being traced (pointer down on the canvas).
  // Drawing works directly (no need to arm it via a button first): any
  // pointer drag on the canvas starts a new stroke.
  let strokeActive = false;
  let rawWorldPts = [];
  let lastPixel = null;
  let strokeBBoxPx = null; // pixel-space bounding box of the in-progress stroke
  let playingBeforeStroke = false;

  // Cache of {resampled, coeffs} keyed by identity of state.drawing.raw, so RMS/topK
  // work doesn't recompute resampleArcLength every frame.
  let cachedRawRef = null;
  let cachedResampled = null;

  function ensureResampled(state) {
    if (state.drawing.raw !== cachedRawRef) {
      cachedRawRef = state.drawing.raw;
      cachedResampled = state.drawing.raw && state.drawing.raw.length > 2
        ? resampleArcLength(state.drawing.raw, RESAMPLE_N, true)
        : null;
    }
    return cachedResampled;
  }

  function updateRms(state) {
    const drawing = state.drawing;
    if (!drawing.coeffs || drawing.coeffs.length === 0) {
      rmsEl.textContent = '—';
      return;
    }
    const resampled = ensureResampled(state);
    if (!resampled) {
      rmsEl.textContent = '—';
      return;
    }
    const K = Math.max(K_MIN, Math.min(K_MAX, state.K));
    const topCoeffs = topKWithDC(drawing.coeffs, K);
    let sumSq = 0;
    for (let n = 0; n < RESAMPLE_N; n += 1) {
      const t = n / RESAMPLE_N;
      const recon = idftEval(topCoeffs, t);
      const dx = recon.re - resampled[n].re;
      const dy = recon.im - resampled[n].im;
      sumSq += dx * dx + dy * dy;
    }
    const rms = Math.sqrt(sumSq / RESAMPLE_N);
    rmsEl.textContent = rms.toFixed(4);
  }

  function initExampleIfEmpty() {
    const state = store.get();
    if (state.drawing.coeffs && state.drawing.coeffs.length > 0) return;
    const raw = normalizePoints(heartRawPoints(300));
    const { coeffs } = computeCoeffs(raw);
    store.set({ drawing: { raw, coeffs, active: false } }, 'draw');
  }

  function clearDrawing() {
    strokeActive = false;
    rawWorldPts = [];
    lastPixel = null;
    strokeBBoxPx = null;
    store.set({ drawing: { raw: [], coeffs: [], active: false } }, 'draw');
    rmsEl.textContent = '—';
    hintEl.textContent = 'Draw a closed shape';
  }

  // ---------- Pointer capture ----------

  function pointerWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - canvasState.w / 2;
    const py = e.clientY - rect.top - canvasState.h / 2;
    const scale = (Math.min(canvasState.w, canvasState.h) / 2) * 0.85;
    const transform = makeTransform({ re: 0, im: 0 }, scale);
    return { world: transform.toWorld(px, py), px, py };
  }

  function addPoint(e) {
    const { world, px, py } = pointerWorld(e);
    if (lastPixel) {
      const d = Math.hypot(px - lastPixel.x, py - lastPixel.y);
      if (d < 2) return;
    }
    lastPixel = { x: px, y: py };
    if (!strokeBBoxPx) {
      strokeBBoxPx = { minX: px, maxX: px, minY: py, maxY: py };
    } else {
      strokeBBoxPx.minX = Math.min(strokeBBoxPx.minX, px);
      strokeBBoxPx.maxX = Math.max(strokeBBoxPx.maxX, px);
      strokeBBoxPx.minY = Math.min(strokeBBoxPx.minY, py);
      strokeBBoxPx.maxY = Math.max(strokeBBoxPx.maxY, py);
    }
    // toWorld() returns {re, im}; every consumer of raw drawing points
    // (resampleArcLength, the dashed-outline renderer, send-to-arm) expects
    // {x, y}, so convert once, here, at the single point of entry.
    rawWorldPts.push({ x: world.re, y: world.im });
  }

  function finishDrawing() {
    strokeActive = false;
    const extent = strokeBBoxPx
      ? Math.max(strokeBBoxPx.maxX - strokeBBoxPx.minX, strokeBBoxPx.maxY - strokeBBoxPx.minY)
      : 0;
    if (rawWorldPts.length < MIN_STROKE_POINTS || extent < MIN_STROKE_EXTENT_PX) {
      hintEl.textContent = 'Stroke too short — trace a bigger closed shape';
      store.set({ playing: playingBeforeStroke }, 'draw');
      return;
    }
    const { coeffs } = computeCoeffs(rawWorldPts);
    store.set({ drawing: { raw: rawWorldPts, coeffs, active: false }, playing: true }, 'draw');
    hintEl.textContent = 'Draw a closed shape';
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    strokeActive = true;
    rawWorldPts = [];
    lastPixel = null;
    strokeBBoxPx = null;
    playingBeforeStroke = store.get().playing;
    store.set({ playing: false }, 'draw');
    hintEl.textContent = 'Trace a closed shape, release to finish';
    addPoint(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!strokeActive || e.buttons !== 1) return;
    addPoint(e);
  });
  canvas.addEventListener('pointerup', () => {
    if (!strokeActive) return;
    finishDrawing();
  });
  canvas.addEventListener('pointercancel', () => {
    if (!strokeActive) return;
    strokeActive = false;
    hintEl.textContent = 'Draw a closed shape';
    store.set({ playing: playingBeforeStroke }, 'draw');
  });

  // Drawing now works directly (drag on the canvas at any time), so
  // #draw-start is no longer required to "arm" a stroke. index.html (owned
  // elsewhere) still wires this button up, so keep it working as a harmless
  // clear-and-prompt shortcut rather than leaving it dead.
  drawStartBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Clear &amp; Draw';
  drawStartBtn.addEventListener('click', () => {
    clearDrawing();
    hintEl.textContent = 'Trace a closed shape directly on the canvas';
  });

  drawClearBtn.addEventListener('click', clearDrawing);

  drawPlayBtn.addEventListener('click', () => {
    const s = store.get();
    store.set({ playing: !s.playing }, 'controls');
  });

  function syncPlayBtn(state) {
    drawPlayBtn.innerHTML = state.playing
      ? '<i class="fa-solid fa-pause"></i> Pause'
      : '<i class="fa-solid fa-play"></i> Play';
  }
  store.subscribe((state) => syncPlayBtn(state), ['playing']);
  syncPlayBtn(store.get());

  function currentK() {
    const min = Number(kSlider.min) || 0;
    const max = Number(kSlider.max) || 1000;
    return sliderToK(parseFloat(kSlider.value), min, max);
  }

  kSlider.addEventListener('input', () => {
    const k = currentK();
    kValueEl.textContent = String(k);
    store.set({ K: k }, 'draw');
    updateRms(store.get());
  });
  kValueEl.textContent = String(currentK());
  store.set({ K: currentK() }, 'draw');

  sendToArmBtn.addEventListener('click', () => {
    const state = store.get();
    if (!state.drawing.coeffs || state.drawing.coeffs.length === 0) return;
    const K = Math.max(K_MIN, Math.min(K_MAX, state.K));
    const topCoeffs = topKWithDC(state.drawing.coeffs, K);
    // Guard against NaN: fromCoeff can only produce a non-finite freq/amp/
    // phase if the source coefficients are already broken upstream, but the
    // arm view/editor have no NaN handling of their own, so filter here
    // rather than ever handing them a broken component. (store.setComponents
    // assigns ids/colors itself; no need to stamp them here.)
    const comps = topCoeffs
      .map((c) => fromCoeff(c, {}))
      .filter((c) => Number.isFinite(c.freq) && Number.isFinite(c.amp) && Number.isFinite(c.phase));
    if (comps.length === 0) return;
    store.setComponents(comps, 'draw');
    store.set({ mode: 'arm' }, 'draw');
  });

  store.subscribe((state) => updateRms(state), ['drawing', 'K']);

  initExampleIfEmpty();
  updateRms(store.get());

  // ---------- Render ----------

  function renderLiveInk(ctx, baseScale) {
    if (rawWorldPts.length < 2) return;
    const transform = makeTransform({ re: 0, im: 0 }, baseScale);
    ctx.save();
    ctx.strokeStyle = cssVar('--accent-color', '#ffa00f');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    rawWorldPts.forEach((p, i) => {
      const px = transform.toPx({ re: p.x, im: p.y });
      if (i === 0) ctx.moveTo(px.x, px.y);
      else ctx.lineTo(px.x, px.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function render(state) {
    const { ctx, w, h } = canvasState;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);

    const baseScale = (Math.min(w, h) / 2) * 0.85;

    // While a stroke is in progress, show only the live ink being traced —
    // hide the previous reconstruction/trail so it doesn't look like the
    // drawing is being ignored.
    if (strokeActive) {
      renderLiveInk(ctx, baseScale);
      ctx.restore();
      return;
    }

    const drawing = state.drawing;
    const hasCoeffs = drawing.coeffs && drawing.coeffs.length > 0;
    const K = Math.max(K_MIN, Math.min(K_MAX, state.K));

    let reconComponents = [];
    let chain = null;
    if (hasCoeffs) {
      const topCoeffs = topKWithDC(drawing.coeffs, K);
      reconComponents = topCoeffs.map((c, i) => ({ ...fromCoeff(c, {}), color: paletteColor(i) }));
      chain = jointPositions(reconComponents, state.t, { re: 0, im: 0 });
    }

    let center = { re: 0, im: 0 };
    let scale = baseScale;
    if (followTipEl.checked && chain) {
      center = chain[chain.length - 1];
      scale = baseScale * 2.2;
    }
    const transform = makeTransform(center, scale);

    // Original drawing, faint dashed.
    if (drawing.raw && drawing.raw.length > 1) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = cssVar('--text-secondary', '#94a3b8');
      ctx.lineWidth = 2;
      ctx.beginPath();
      drawing.raw.forEach((p, i) => {
        const px = transform.toPx({ re: p.x, im: p.y });
        if (i === 0) ctx.moveTo(px.x, px.y);
        else ctx.lineTo(px.x, px.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    if (hasCoeffs && chain) {
      // Faint epicycle guide circles (single path).
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = cssVar('--border-color', '#334155');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < reconComponents.length; i += 1) {
        const base = chain[i];
        const r = reconComponents[i].amp * scale;
        if (r < 0.5) continue;
        const c = transform.toPx(base);
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.restore();

      // Vector chain (links).
      ctx.save();
      ctx.strokeStyle = cssVar('--text-muted', '#64748b');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      chain.forEach((p, i) => {
        const px = transform.toPx(p);
        if (i === 0) ctx.moveTo(px.x, px.y);
        else ctx.lineTo(px.x, px.y);
      });
      ctx.stroke();
      ctx.restore();

      // Fading ring-buffer trail of the last full period, newest (at tip) opaque.
      const tip = chain[chain.length - 1];
      const trailPts = new Array(TRAIL_POINTS);
      for (let i = 0; i < TRAIL_POINTS; i += 1) {
        const back = ((TRAIL_POINTS - 1 - i) / TRAIL_POINTS);
        const t = ((state.t - back) % 1 + 1) % 1;
        const c = jointPositions(reconComponents, t, { re: 0, im: 0 });
        trailPts[i] = c[c.length - 1];
      }
      ctx.save();
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      const primary = cssVar('--primary-color', '#00693e');
      for (let i = 0; i < trailPts.length - 1; i += 1) {
        const alpha = i / (trailPts.length - 1);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = primary;
        const a = transform.toPx(trailPts[i]);
        const b = transform.toPx(trailPts[i + 1]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();

      // Tip marker.
      ctx.save();
      ctx.fillStyle = cssVar('--accent-color', '#ffa00f');
      const tp = transform.toPx(tip);
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  function resize() {
    // setupCanvas keeps the backing store sized via ResizeObserver; nothing else to do.
  }

  function destroy() {
    canvasState.destroy();
  }

  return { render, resize, destroy };
}
