// Freehand draw capture + 3Blue1Brown-style epicycle reconstruction animation.
import { setupCanvas, makeTransform, cssVar } from './canvas.js';
import { resampleArcLength, dft, idftEval, topK, fromCoeff } from '../core/fourier.js';
import { jointPositions } from '../core/arm.js';

const PALETTE = ['#267aba', '#ffa00f', '#a5d75f', '#8a6996', '#d94415', '#f5dc69', '#c4dd88', '#9d162e'];
const K_MIN = 1;
const K_MAX = 512;
const RESAMPLE_N = 512;
const TRAIL_POINTS = 240;

// Workaround: store.setComponents() does not assign ids/colors to id-less
// entries (only store.addComponent() does), so components sharing id ===
// undefined would all match each other in removeComponent/updateComponent.
// Stamp fresh ids from a block far above anything store.addComponent will
// ever generate.
let externalIdCounter = 2000000;
function withIdsAndColors(list) {
  return list.map((c, i) => ({ ...c, id: externalIdCounter++, color: PALETTE[i % PALETTE.length] }));
}

function paletteColor(i) {
  return PALETTE[i % PALETTE.length];
}

function sliderToK(pos, max = 1000) {
  const t = Math.max(0, Math.min(1, pos / max));
  const k = Math.round(Math.exp(Math.log(K_MIN) + t * (Math.log(K_MAX) - Math.log(K_MIN))));
  return Math.min(K_MAX, Math.max(K_MIN, k));
}

function kToSlider(k, max = 1000) {
  const clamped = Math.min(K_MAX, Math.max(K_MIN, k));
  const t = (Math.log(clamped) - Math.log(K_MIN)) / (Math.log(K_MAX) - Math.log(K_MIN));
  return Math.round(t * max);
}

/** Standard parametric heart curve, used as the pre-loaded example drawing. */
function heartRawPoints(n = 300) {
  const pts = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push({ x, y: -y }); // flip so the heart points up in world (y-up) space
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

  let capturing = false;
  let rawWorldPts = [];
  let lastPixel = null;

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
    const topCoeffs = topK(drawing.coeffs, K);
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

  function setDrawing(patch) {
    store.set({ drawing: { ...store.get().drawing, ...patch } }, 'draw');
  }

  function initExampleIfEmpty() {
    const state = store.get();
    if (state.drawing.coeffs && state.drawing.coeffs.length > 0) return;
    const raw = normalizePoints(heartRawPoints(300));
    const { coeffs } = computeCoeffs(raw);
    store.set({ drawing: { raw, coeffs, active: false } }, 'draw');
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
    rawWorldPts.push(world);
  }

  function finishDrawing() {
    capturing = false;
    if (rawWorldPts.length < 3) {
      hintEl.textContent = 'Draw a closed shape';
      return;
    }
    const { coeffs } = computeCoeffs(rawWorldPts);
    store.set({ drawing: { raw: rawWorldPts, coeffs, active: false }, playing: true }, 'draw');
    hintEl.textContent = 'Draw a closed shape';
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!capturing) return;
    canvas.setPointerCapture(e.pointerId);
    rawWorldPts = [];
    lastPixel = null;
    addPoint(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!capturing || e.buttons !== 1) return;
    addPoint(e);
  });
  canvas.addEventListener('pointerup', () => {
    if (!capturing) return;
    finishDrawing();
  });

  drawStartBtn.addEventListener('click', () => {
    capturing = true;
    rawWorldPts = [];
    lastPixel = null;
    store.set({ playing: false }, 'draw');
    hintEl.textContent = 'Trace a closed shape, release to finish';
  });

  drawClearBtn.addEventListener('click', () => {
    capturing = false;
    rawWorldPts = [];
    store.set({ drawing: { raw: [], coeffs: [], active: false } }, 'draw');
    rmsEl.textContent = '—';
    hintEl.textContent = 'Draw a closed shape';
  });

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

  kSlider.addEventListener('input', () => {
    const k = sliderToK(parseFloat(kSlider.value));
    kValueEl.textContent = String(k);
    store.set({ K: k }, 'draw');
    updateRms(store.get());
  });
  kValueEl.textContent = String(sliderToK(parseFloat(kSlider.value)));
  store.set({ K: sliderToK(parseFloat(kSlider.value)) }, 'draw');

  sendToArmBtn.addEventListener('click', () => {
    const state = store.get();
    if (!state.drawing.coeffs || state.drawing.coeffs.length === 0) return;
    const K = Math.max(K_MIN, Math.min(K_MAX, state.K));
    const topCoeffs = topK(state.drawing.coeffs, K);
    const comps = withIdsAndColors(topCoeffs.map((c) => fromCoeff(c, {})));
    store.setComponents(comps, 'draw');
    store.set({ mode: 'arm' }, 'draw');
  });

  store.subscribe((state) => updateRms(state), ['drawing', 'K']);

  initExampleIfEmpty();
  updateRms(store.get());

  // ---------- Render ----------

  function render(state) {
    const { ctx, w, h } = canvasState;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);

    const baseScale = (Math.min(w, h) / 2) * 0.85;
    const drawing = state.drawing;
    const hasCoeffs = drawing.coeffs && drawing.coeffs.length > 0;
    const K = Math.max(K_MIN, Math.min(K_MAX, state.K));

    let reconComponents = [];
    let chain = null;
    if (hasCoeffs) {
      const topCoeffs = topK(drawing.coeffs, K);
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
