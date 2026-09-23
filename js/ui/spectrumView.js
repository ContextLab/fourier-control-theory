// Stem-plot view of the Fourier spectrum: amplitude/power vs. integer frequency,
// with phase shown as a tick + ring handle, drag to edit, dblclick to add,
// Delete/Backspace to remove, shift-drop to merge duplicate frequencies.
import { setupCanvas, cssVar } from './canvas.js';
import { add, abs, arg, fromPolar } from '../core/complex.js';
import { MAX_FREQ, MAX_AMP } from '../core/store.js';
import { MAIN_JOINT_IDS } from '../core/gesture.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const GESTURE_MAX_H = 4; // H <= 4 per core/gesture.js's joint-angle series model

const HEAD_HIT = 10; // px
const STEM_HIT = 6; // px, horizontal tolerance
const RING_RADIUS = 16; // px
const RING_HIT = 8; // px tolerance around the ring handle dot
const MARGIN = { left: 44, right: 18, top: 16, bottom: 26 };
const FREQ_SNAP_MS = 140; // visual easing duration for horizontal snap
const TWO_PI = Math.PI * 2;
const MAX_LABELS = 12; // hard cap on ticks/labels drawn, regardless of F
const LABEL_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
// Small inline rotate-ish cursor (curved arrow) for the phase ring handle;
// 'grab' fallback after the comma covers browsers that reject the data URI.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">'
  + '<path d="M4 10a6 6 0 1 0 2-4.5" fill="none" stroke="black" stroke-width="1.6"/>'
  + '<path d="M4.5 3.5l-0.7 3.4 3.4 0.2" fill="none" stroke="black" stroke-width="1.6"/>'
  + '</svg>',
)}") 10 10, grab`;

function themeFont(px) {
  const family = (typeof document !== 'undefined'
    && document.body
    && getComputedStyle(document.body).fontFamily) || 'sans-serif';
  return `${px}px ${family}`;
}

function wrapAngle(a) {
  let x = a % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  return x;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../core/store.js').createStore>} store
 * @param {{interactive?: boolean}} [opts]
 */
export function createSpectrumView(canvas, store, opts = {}) {
  const { interactive = true } = opts;

  const cv = setupCanvas(canvas);
  canvas.setAttribute('role', interactive ? 'application' : 'img');
  canvas.setAttribute(
    'aria-label',
    interactive
      ? 'Fourier spectrum editor: stem plot of frequency components. Drag a stem to change '
        + 'amplitude and frequency, alt-drag or use the phase ring to change phase, '
        + 'double-click to add a component, Delete to remove the selected one.'
      : 'Fourier spectrum: stem plot of frequency components.',
  );
  if (interactive) {
    canvas.tabIndex = 0;
    // 'none' would block page scrolling on touch entirely. Allow vertical pan
    // + pinch-zoom by default; onTouchStart below cancels that per-gesture
    // (via preventDefault, since touch-action can't change mid-gesture) only
    // when the touch actually starts on a stem/head/ring, so those still drag.
    canvas.style.touchAction = 'pan-y pinch-zoom';
    canvas.style.outline = 'none';
  }

  let hasInteracted = false;
  function markInteracted() { hasInteracted = true; }

  let colors = readColors();
  function readColors() {
    return {
      bg: cssVar('--bg-color', '#0f172a'),
      surface: cssVar('--surface-color', '#1e293b'),
      textSecondary: cssVar('--text-secondary', '#94a3b8'),
      border: cssVar('--border-color', '#334155'),
      primary: cssVar('--primary-color', '#00693e'),
      accent: cssVar('--accent-color', '#ffa00f'),
    };
  }
  const onThemeChange = () => { colors = readColors(); };
  document.addEventListener('themechange', onThemeChange);

  // Layout cached from the most recent render(), used by event handlers.
  let layout = { F: 5, yMax: 1, plotX: 0, plotY: 0, plotW: 1, plotH: 1 };
  let lastStems = []; // [{id, comp, freq, dispFreq, value, px, py}]

  const freqAnim = new Map(); // id -> { from, to, start }

  let dragging = null; // { id, mode: 'move'|'phase-ring', startX, startY, startPhase, startFreqInt }
  let hoverId = null;

  // -- Gesture mode: joint-angle spectrum for the currently-selected joint --
  // (mean q̄ at h=0, then each harmonic's amplitude/phase) — showing every one
  // of the 18 joints at once would be unreadable, so this focuses on one
  // joint at a time; select a different joint on the arm or in the editor to
  // inspect its spectrum here.
  let lastGestureStems = []; // [{h, isMean, px, py, baseY}]
  let lastGestureLayout = null;
  let lastGestureBoneId = null;

  function selectedGestureBone(state, bones) {
    return bones.find((b) => b.id === state.selectedId) || bones.find((b) => b.id === MAIN_JOINT_IDS[0]);
  }

  function renderGestureSpectrum(state, bones) {
    const { ctx, w, h } = cv;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    const bone = selectedGestureBone(state, bones);
    lastGestureBoneId = bone.id;
    const entries = [{ h: 0, val: bone.series.mean * RAD2DEG, isMean: true, phase: 0 }];
    for (const hm of bone.series.harmonics) entries.push({ h: hm.h, val: hm.amp * RAD2DEG, isMean: false, phase: hm.phase });

    const plotX = MARGIN.left;
    const plotY = MARGIN.top;
    const plotW = Math.max(1, cv.w - MARGIN.left - MARGIN.right);
    const plotH = Math.max(1, cv.h - MARGIN.top - MARGIN.bottom);
    const maxAbs = Math.max(20, ...entries.map((e) => Math.abs(e.val))) * 1.25;
    const F = GESTURE_MAX_H;
    const xToPx = (hIdx) => plotX + ((hIdx + 0.5) / (F + 1)) * plotW;
    const midY = plotY + plotH / 2;
    const valToPx = (v) => midY - (v / maxAbs) * (plotH / 2);
    lastGestureLayout = {
      plotX, plotY, plotW, plotH, midY, maxAbs, xToPx, valToPx,
    };

    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, midY);
    ctx.lineTo(plotX + plotW, midY);
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.fillStyle = colors.textSecondary;
    ctx.textAlign = 'center';
    for (let hIdx = 0; hIdx <= F; hIdx++) {
      const px = xToPx(hIdx);
      ctx.fillText(hIdx === 0 ? 'mean' : `h=${hIdx}`, px, plotY + plotH + 14);
    }
    ctx.textAlign = 'left';
    ctx.fillText(`${bone.label} — deg`, plotX, plotY - 4);

    lastGestureStems = [];
    for (const e of entries) {
      const px = xToPx(e.h);
      const py = valToPx(e.val);
      const selected = true; // only one joint shown at a time
      const hovered = hoverId === `g-${e.h}`;
      ctx.beginPath();
      ctx.strokeStyle = bone.color || colors.primary;
      ctx.lineWidth = 2;
      ctx.moveTo(px, midY);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = bone.color || colors.primary;
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 1.5;
      ctx.arc(px, py, hovered ? 7 : 5.5, 0, TWO_PI);
      ctx.fill();
      ctx.stroke();
      if (!e.isMean) {
        const tickLen = 9;
        ctx.beginPath();
        ctx.strokeStyle = colors.textSecondary;
        ctx.lineWidth = 1.5;
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(e.phase) * tickLen, py - Math.sin(e.phase) * tickLen);
        ctx.stroke();
      }
      lastGestureStems.push({
        h: e.h, isMean: e.isMean, px, py, baseY: midY,
      });
      void selected;
    }

    if (!hasInteracted && plotW >= 260) {
      ctx.font = themeFont(11);
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.textSecondary;
      ctx.globalAlpha = 0.6;
      ctx.fillText('drag ↕ amplitude (or mean) · alt-drag ↕ phase', plotX + plotW / 2, plotY + plotH + 30);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function hitGestureStem(x, y) {
    let best = null;
    let bestDist = HEAD_HIT;
    for (const s of lastGestureStems) {
      const d = Math.hypot(s.px - x, s.py - y);
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function valueOf(comp, yScale) {
    return yScale === 'power' ? comp.amp * comp.amp : Math.abs(comp.amp);
  }
  function ampFromValue(value, yScale) {
    return yScale === 'power' ? Math.sqrt(Math.max(0, value)) : Math.max(0, value);
  }

  let currentF = 5;
  let currentYMax = 1;
  let axisInitialized = false;
  const AXIS_EASE = 0.15;

  function computeLayout(state, components) {
    let maxAbsFreq = 0;
    let maxValue = 1e-6;
    for (const c of components) {
      maxAbsFreq = Math.max(maxAbsFreq, Math.abs(c.freq));
      maxValue = Math.max(maxValue, valueOf(c, state.yScale));
    }
    const targetF = Math.max(5, maxAbsFreq + 3);
    const targetYMax = maxValue * 1.15;

    if (!axisInitialized) {
      currentF = targetF;
      currentYMax = targetYMax;
      axisInitialized = true;
    } else if (!dragging) {
      // Both axes are frozen while a drag is in progress: an eased x-range
      // that grows as the dragged freq grows would let the pointer keep
      // "outrunning" the axis and the frequency runs away without bound.
      currentF += (targetF - currentF) * AXIS_EASE;
      currentYMax += (targetYMax - currentYMax) * AXIS_EASE;
    }

    const plotX = MARGIN.left;
    const plotY = MARGIN.top;
    const plotW = Math.max(1, cv.w - MARGIN.left - MARGIN.right);
    const plotH = Math.max(1, cv.h - MARGIN.top - MARGIN.bottom);
    return { F: currentF, yMax: currentYMax, plotX, plotY, plotW, plotH };
  }

  function xToPx(freq, L) {
    return L.plotX + ((freq + L.F) / (2 * L.F)) * L.plotW;
  }
  function pxToX(px, L) {
    return (px - L.plotX) / L.plotW * (2 * L.F) - L.F;
  }
  function yToPx(value, L) {
    return L.plotY + L.plotH - Math.min(1, Math.max(0, value / L.yMax)) * L.plotH;
  }
  function pxToY(py, L) {
    const frac = (L.plotY + L.plotH - py) / L.plotH;
    return frac * L.yMax;
  }

  function groupByFreq(components) {
    const groups = new Map();
    for (const c of components) {
      const f = Math.round(c.freq);
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f).push(c);
    }
    return groups;
  }

  function render(state, derived) {
    if (state.motion === 'gesture' && state.gesture && state.gesture.bones) {
      renderGestureSpectrum(state, state.gesture.bones);
      return;
    }
    const { ctx, w, h } = cv;
    const components = state.components || [];
    const L = computeLayout(state, components);
    layout = L;

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Axes.
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.plotX, L.plotY);
    ctx.lineTo(L.plotX, L.plotY + L.plotH);
    ctx.lineTo(L.plotX + L.plotW, L.plotY + L.plotH);
    ctx.stroke();

    // Baseline / zero-frequency emphasis.
    const zeroX = xToPx(0, L);
    ctx.strokeStyle = colors.border;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(zeroX, L.plotY);
    ctx.lineTo(zeroX, L.plotY + L.plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Integer frequency ticks: only every `labelStep`-th integer gets a tick
    // + label, chosen from a "nice number" sequence so labels never collide,
    // and the loop is capped at MAX_LABELS iterations regardless of F.
    const fLo = Math.ceil(-L.F);
    const fHi = Math.floor(L.F);
    const span = Math.max(1, fHi - fLo);
    let labelStep = LABEL_STEPS[LABEL_STEPS.length - 1];
    for (const s of LABEL_STEPS) {
      if (span / s <= MAX_LABELS) { labelStep = s; break; }
    }
    ctx.fillStyle = colors.textSecondary;
    ctx.font = themeFont(10);
    ctx.textAlign = 'center';
    // First tick is the nearest multiple of labelStep at or above fLo, so
    // ticks land on round numbers (…, -10, 0, 10, …) rather than drifting
    // with fLo as F eases.
    const firstTick = Math.ceil(fLo / labelStep) * labelStep;
    for (let f = firstTick; f <= fHi; f += labelStep) {
      const px = xToPx(f, L);
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(px, L.plotY + L.plotH);
      ctx.lineTo(px, L.plotY + L.plotH + 4);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(f), px, L.plotY + L.plotH + 15);
    }
    // y-axis ticks (0, half, max).
    ctx.textAlign = 'right';
    for (const frac of [0, 0.5, 1]) {
      const val = frac * L.yMax;
      const py = yToPx(val, L);
      ctx.fillText(val.toFixed(2), L.plotX - 6, py + 3);
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.moveTo(L.plotX, py);
      ctx.lineTo(L.plotX + L.plotW, py);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    ctx.fillText(state.yScale === 'power' ? 'power' : 'amp', L.plotX, L.plotY - 4);

    // Duplicate-frequency combined bars.
    const groups = groupByFreq(components);
    if (derived && derived.spectrum) {
      for (const [f, list] of groups) {
        if (list.length < 2) continue;
        const entry = derived.spectrum.get(f);
        if (!entry) continue;
        const combinedAmp = abs(entry.sum);
        const combinedValue = valueOf({ amp: combinedAmp }, state.yScale);
        const px = xToPx(f, L);
        const py = yToPx(combinedValue, L);
        ctx.fillStyle = colors.textSecondary;
        ctx.globalAlpha = 0.22;
        const barW = 14;
        ctx.fillRect(px - barW / 2, py, barW, L.plotY + L.plotH - py);
        ctx.globalAlpha = 1;
      }
    }

    // Stems.
    const now = performance.now();
    lastStems = [];
    for (const [f, list] of groups) {
      const n = list.length;
      list.forEach((comp, idx) => {
        const offset = n > 1 ? (idx - (n - 1) / 2) * 0.18 : 0;
        let dispFreq = f + offset;
        const anim = freqAnim.get(comp.id);
        if (anim) {
          const t = Math.min(1, (now - anim.start) / FREQ_SNAP_MS);
          const eased = 1 - (1 - t) * (1 - t);
          dispFreq = anim.from + (dispFreq - anim.from) * eased;
          if (t >= 1) freqAnim.delete(comp.id);
        }
        const value = valueOf(comp, state.yScale);
        const px = xToPx(dispFreq, L);
        const py = yToPx(value, L);
        const baseY = L.plotY + L.plotH;
        const selected = state.selectedId === comp.id;
        const hovered = hoverId === comp.id;
        const color = comp.color || colors.primary;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.moveTo(px, baseY);
        ctx.lineTo(px, py);
        ctx.stroke();

        if (selected) {
          ctx.beginPath();
          ctx.fillStyle = colors.accent;
          ctx.globalAlpha = 0.22;
          ctx.arc(px, py, 12, 0, TWO_PI);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        // Head.
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.strokeStyle = colors.bg;
        ctx.lineWidth = 1.5;
        ctx.arc(px, py, hovered || selected ? 6 : 5, 0, TWO_PI);
        ctx.fill();
        ctx.stroke();

        // Phase tick.
        const tickLen = 10;
        ctx.beginPath();
        ctx.strokeStyle = colors.textSecondary;
        ctx.lineWidth = 1.5;
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(comp.phase) * tickLen, py - Math.sin(comp.phase) * tickLen);
        ctx.stroke();

        // Phase ring handle for the selected component.
        if (selected && interactive) {
          ctx.beginPath();
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = 0.5;
          ctx.setLineDash([2, 3]);
          ctx.arc(px, py, RING_RADIUS, 0, TWO_PI);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          const hx = px + Math.cos(comp.phase) * RING_RADIUS;
          const hy = py - Math.sin(comp.phase) * RING_RADIUS;
          ctx.beginPath();
          ctx.fillStyle = colors.accent;
          ctx.arc(hx, hy, 4, 0, TWO_PI);
          ctx.fill();
        }

        lastStems.push({ id: comp.id, comp, freq: f, px, py, baseY, headX: px, headY: py });
      });
    }

    // Affordance hint: shown only while nothing is selected and before the
    // user's first interaction with this view, and only once the plot is
    // wide enough for both lines to fit without wrapping/overlapping the
    // stems (fixed strings, not measured/wrapped) — on a narrow mobile
    // viewport (~390px) it's simply omitted rather than clipped or drawn on
    // top of the stems.
    const HINT_MIN_WIDTH = 360;
    if (!state.selectedId && !hasInteracted && L.plotW >= HINT_MIN_WIDTH) {
      ctx.font = themeFont(11);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.textSecondary;
      ctx.globalAlpha = 0.55;
      const cx = L.plotX + L.plotW / 2;
      const cy = L.plotY + L.plotH / 2;
      ctx.fillText('drag a stem: ↕ amplitude ↔ frequency', cx, cy - 7);
      ctx.fillText(
        'alt-drag or ring: phase · double-click: add · Del: remove',
        cx,
        cy + 7,
      );
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();
  }

  // --- Interaction -------------------------------------------------------

  function localXY(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  function hitHead(x, y) {
    let best = null;
    let bestDist = HEAD_HIT;
    for (const s of lastStems) {
      const d = Math.hypot(s.headX - x, s.headY - y);
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function hitStem(x, y) {
    let best = null;
    let bestDist = STEM_HIT;
    for (const s of lastStems) {
      if (y < Math.min(s.py, s.baseY) - 4 || y > s.baseY + 4) continue;
      const d = Math.abs(s.px - x);
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function hitRingHandle(x, y, state) {
    if (!state.selectedId) return null;
    const s = lastStems.find((st) => st.id === state.selectedId);
    if (!s) return null;
    const hx = s.headX + Math.cos(s.comp.phase) * RING_RADIUS;
    const hy = s.headY - Math.sin(s.comp.phase) * RING_RADIUS;
    return Math.hypot(hx - x, hy - y) <= RING_HIT ? s : null;
  }

  function onPointerDown(evt) {
    const { x, y } = localXY(evt);
    const state = store.get();
    canvas.focus();
    markInteracted();

    if (state.motion === 'gesture' && state.gesture) {
      const s = hitGestureStem(x, y);
      if (!s) return;
      dragging = { gesture: true, boneId: lastGestureBoneId, h: s.h, isMean: s.isMean };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }

    const ring = hitRingHandle(x, y, state);
    if (ring) {
      dragging = { id: ring.id, mode: 'phase-ring' };
      canvas.style.cursor = ROTATE_CURSOR;
      canvas.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }

    const head = hitHead(x, y) || hitStem(x, y);
    if (head) {
      store.set({ selectedId: head.id }, 'spectrum');
      dragging = {
        id: head.id,
        mode: 'move',
        startFreqInt: Math.round(head.comp.freq),
        // Captured so a shift-drop merge combines the component's pre-drag
        // amp/phase, not a value already nudged by an alt+vertical phase
        // gesture earlier in the same drag.
        origAmp: head.comp.amp,
        origPhase: head.comp.phase,
        // Grab offset (pointer y minus head y at pointerdown): grabbing the
        // stem's line rather than its head starts with a nonzero offset, and
        // applying it on every move keeps amp changes relative to the grab
        // point instead of snapping the head straight to the pointer.
        grabDy: y - head.py,
      };
      canvas.style.cursor = 'grabbing';
      canvas.setPointerCapture(evt.pointerId);
      evt.preventDefault();
      return;
    }

    store.set({ selectedId: null }, 'spectrum');
  }

  function onDblClick(evt) {
    const { x, y } = localXY(evt);
    const state = store.get();
    markInteracted();
    if (state.motion === 'gesture') return; // "add a component" is a spin-mode-only action
    // Ignore dblclick on an existing stem/head (that's a selection double-click,
    // not "add"); only add when the second click lands on empty plot area.
    if (hitHead(x, y) || hitStem(x, y)) return;
    const freq = Math.round(pxToX(x, layout));
    const value = Math.max(0, pxToY(y, layout));
    const amp = ampFromValue(value, state.yScale);
    const id = store.addComponent({ freq, amp, phase: 0 });
    store.set({ selectedId: id }, 'spectrum');
  }

  function onPointerMove(evt) {
    const { x, y } = localXY(evt);

    if (dragging && dragging.gesture) {
      const state = store.get();
      const bones = state.gesture && state.gesture.bones;
      const L = lastGestureLayout;
      if (!bones || !L) return;
      const value = L.maxAbs * ((L.midY - y) / (L.plotH / 2)); // degrees
      if (dragging.isMean) {
        const clamped = Math.max(-180, Math.min(180, value));
        store.updateJointMean(dragging.boneId, clamped * DEG2RAD, 'spectrum');
      } else if (evt.altKey) {
        const bone = bones.find((b) => b.id === dragging.boneId);
        const harmonic = bone && bone.series.harmonics.find((hm) => hm.h === dragging.h);
        if (dragging.phaseStartY === undefined) {
          dragging.phaseStartY = y;
          dragging.phaseStart = harmonic ? harmonic.phase : 0;
        }
        const dphase = ((dragging.phaseStartY - y) / 100) * TWO_PI;
        store.updateJointHarmonic(dragging.boneId, dragging.h, { phase: wrapAngle(dragging.phaseStart + dphase) }, 'spectrum');
      } else {
        dragging.phaseStartY = undefined;
        const amp = Math.max(0, value);
        store.updateJointHarmonic(dragging.boneId, dragging.h, { amp: amp * DEG2RAD }, 'spectrum');
      }
      evt.preventDefault();
      return;
    }

    if (!dragging) {
      const state = store.get();
      if (state.motion === 'gesture' && state.gesture) {
        const hit = hitGestureStem(x, y);
        hoverId = hit ? `g-${hit.h}` : null;
        canvas.style.cursor = hit ? 'grab' : 'crosshair';
        return;
      }
      const ring = hitRingHandle(x, y, state);
      const hit = ring || hitHead(x, y) || hitStem(x, y);
      hoverId = hit ? hit.id : null;
      if (ring) {
        canvas.style.cursor = ROTATE_CURSOR;
      } else if (hit) {
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = 'crosshair';
      }
      return;
    }
    const state = store.get();
    const comp = state.components.find((c) => c.id === dragging.id);
    if (!comp) return;

    if (dragging.mode === 'phase-ring') {
      const s = lastStems.find((st) => st.id === dragging.id);
      if (s) {
        const phase = Math.atan2(-(y - s.headY), x - s.headX);
        store.updateComponent(dragging.id, { phase }, 'spectrum');
      }
      evt.preventDefault();
      return;
    }

    // mode === 'move'. The x-range (layout.F) is frozen by computeLayout
    // while `dragging` is set; freqInt is clamped both to MAX_FREQ and to the
    // visible integer range [-floor(F), floor(F)] here (in addition to the
    // store's own sanitizeComponent) so dragging past the canvas edge can't
    // push the value beyond what's actually shown on the frozen axis.
    let freqInt = Math.round(pxToX(x, layout));
    const visibleMax = Math.min(MAX_FREQ, Math.floor(layout.F));
    freqInt = Math.max(-visibleMax, Math.min(visibleMax, freqInt));
    if (freqInt !== dragging.startFreqInt) {
      freqAnim.set(dragging.id, { from: dragging.startFreqInt, start: performance.now() });
      dragging.startFreqInt = freqInt;
    }

    if (evt.altKey) {
      // Phase gesture: alt/option + vertical drag (ring handle also works).
      // Shift is reserved for shift-drop = merge and must not affect phase.
      if (dragging.phaseStartY === undefined) {
        dragging.phaseStartY = y;
        dragging.phaseStart = comp.phase;
      }
      const dphase = ((dragging.phaseStartY - y) / 100) * TWO_PI;
      store.updateComponent(dragging.id, { freq: freqInt, phase: wrapAngle(dragging.phaseStart + dphase) }, 'spectrum');
    } else {
      dragging.phaseStartY = undefined;
      // Apply the grab offset so amp tracks the pointer's movement relative
      // to where the stem was grabbed, rather than snapping the head to
      // whatever y the pointer landed on.
      const adjY = y - (dragging.grabDy || 0);
      const value = Math.max(0, pxToY(adjY, layout));
      let amp = ampFromValue(value, state.yScale);
      amp = Math.max(0, Math.min(MAX_AMP, amp));
      store.updateComponent(dragging.id, { freq: freqInt, amp }, 'spectrum');
    }
    evt.preventDefault();
  }

  function onPointerUp(evt) {
    if (!dragging) return;
    if (dragging.gesture) {
      try { canvas.releasePointerCapture(evt.pointerId); } catch { /* noop */ }
      dragging = null;
      const { x, y } = localXY(evt);
      const hit = hitGestureStem(x, y);
      canvas.style.cursor = hit ? 'grab' : 'crosshair';
      return;
    }
    if (dragging.mode === 'move' && evt.shiftKey) {
      const state = store.get();
      const comp = state.components.find((c) => c.id === dragging.id);
      if (comp) {
        const targetFreq = Math.round(comp.freq);
        const other = state.components.find(
          (c) => c.id !== comp.id && Math.round(c.freq) === targetFreq,
        );
        if (other) {
          const merged = add(
            fromPolar(dragging.origAmp, dragging.origPhase),
            fromPolar(other.amp, other.phase),
          );
          store.updateComponent(other.id, { amp: abs(merged), phase: arg(merged) }, 'spectrum');
          store.removeComponent(comp.id);
          store.set({ selectedId: other.id }, 'spectrum');
        }
      }
    }
    try { canvas.releasePointerCapture(evt.pointerId); } catch { /* noop */ }
    dragging = null;
    const { x, y } = localXY(evt);
    const state = store.get();
    const ring = hitRingHandle(x, y, state);
    const hit = ring || hitHead(x, y) || hitStem(x, y);
    canvas.style.cursor = ring ? ROTATE_CURSOR : (hit ? 'grab' : 'crosshair');
  }

  /**
   * True when (x, y) is over the selected component's head or its phase ring
   * (within RING_RADIUS + RING_HIT of the head), used to gate wheel-as-phase
   * so the page can still scroll everywhere else on the canvas.
   */
  function overSelectedHandle(x, y, state) {
    if (!state.selectedId) return false;
    const s = lastStems.find((st) => st.id === state.selectedId);
    if (!s) return false;
    return Math.hypot(s.headX - x, s.headY - y) <= RING_RADIUS + RING_HIT;
  }

  function onWheel(evt) {
    const state = store.get();
    if (document.activeElement !== canvas) return; // let the page scroll
    if (state.motion === 'gesture') return; // gesture-mode phase editing is alt-drag only
    if (!state.selectedId) return;
    const comp = state.components.find((c) => c.id === state.selectedId);
    if (!comp) return;
    const { x, y } = localXY(evt);
    if (!overSelectedHandle(x, y, state)) return; // let the page scroll
    evt.preventDefault();
    markInteracted();
    const step = evt.deltaY > 0 ? -0.02 : 0.02;
    store.updateComponent(state.selectedId, { phase: wrapAngle(comp.phase + step * TWO_PI) }, 'spectrum');
  }

  /**
   * touch-action can't be changed mid-gesture, so this non-passive listener
   * cancels the browser's default pan only when the touch actually starts on
   * a stem/head/ring (so that gesture drags instead of scrolling); any other
   * touch on the canvas is left alone and the page scrolls normally.
   */
  function onTouchStart(evt) {
    const touch = evt.touches && evt.touches[0];
    if (!touch) return;
    const { x, y } = localXY(touch);
    const state = store.get();
    if (state.motion === 'gesture') {
      if (hitGestureStem(x, y)) evt.preventDefault();
      return;
    }
    const hit = hitRingHandle(x, y, state) || hitHead(x, y) || hitStem(x, y);
    if (hit) evt.preventDefault();
  }

  function onKeyDown(evt) {
    if (evt.key !== 'Delete' && evt.key !== 'Backspace') return;
    const state = store.get();
    if (state.motion === 'gesture') return; // no delete-a-joint action in gesture mode
    if (!state.selectedId) return;
    evt.preventDefault();
    markInteracted();
    store.removeComponent(state.selectedId);
    store.set({ selectedId: null }, 'spectrum');
  }

  if (interactive) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  }

  function resize() {
    cv.refresh();
  }

  function destroy() {
    document.removeEventListener('themechange', onThemeChange);
    if (interactive) {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('touchstart', onTouchStart);
    }
    cv.destroy();
  }

  /** Stem heads from the last render, in CSS px relative to the canvas's top-left. */
  function stemHeads() {
    return lastStems.map((st) => ({ id: st.id, freq: st.freq, x: st.headX, y: st.headY, baseY: st.baseY }));
  }

  return { render, resize, destroy, stemHeads };
}
