// Stem-plot view of the Fourier spectrum: amplitude/power vs. integer frequency,
// with phase shown as a tick + ring handle, drag to edit, dblclick to add,
// Delete/Backspace to remove, shift-drop to merge duplicate frequencies.
import { setupCanvas, cssVar } from './canvas.js';
import { add, abs, arg, fromPolar } from '../core/complex.js';
import { MAX_FREQ, MAX_AMP } from '../core/store.js';

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
    canvas.style.touchAction = 'none';
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
    // user's first interaction with this view.
    if (!state.selectedId && !hasInteracted) {
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
    if (!dragging) {
      const state = store.get();
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
    // while `dragging` is set, and freqInt is clamped to MAX_FREQ here (in
    // addition to the store's own sanitizeComponent) so the displayed value
    // can't run away even if the pointer is dragged far past the canvas edge.
    let freqInt = Math.round(pxToX(x, layout));
    freqInt = Math.max(-MAX_FREQ, Math.min(MAX_FREQ, freqInt));
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
      const value = Math.max(0, pxToY(y, layout));
      let amp = ampFromValue(value, state.yScale);
      amp = Math.max(0, Math.min(MAX_AMP, amp));
      store.updateComponent(dragging.id, { freq: freqInt, amp }, 'spectrum');
    }
    evt.preventDefault();
  }

  function onPointerUp(evt) {
    if (!dragging) return;
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

  function onKeyDown(evt) {
    if (evt.key !== 'Delete' && evt.key !== 'Backspace') return;
    const state = store.get();
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
    }
    cv.destroy();
  }

  /** Stem heads from the last render, in CSS px relative to the canvas's top-left. */
  function stemHeads() {
    return lastStems.map((st) => ({ id: st.id, freq: st.freq, x: st.headX, y: st.headY, baseY: st.baseY }));
  }

  return { render, resize, destroy, stemHeads };
}
