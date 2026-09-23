// theta_k(t) plot + control-theory overlays: bandwidth truncation, signal
// spectrum, first-order actuator-lag feedback filter.
import { setupCanvas, cssVar } from './canvas.js';
import { jointAngles } from '../core/arm.js';
import { lowpass, idftEval } from '../core/fourier.js';
import { forwardKinematics, sampleTipPath, MAIN_JOINT_IDS } from '../core/gesture.js';

const THETA_SAMPLES = 200;
const RAD2DEG = 180 / Math.PI;

/** Wraps radians to (-180, 180]. */
function wrapDeg180(deg) {
  let wrapped = deg % 360;
  if (wrapped <= -180) wrapped += 360;
  if (wrapped > 180) wrapped -= 360;
  return wrapped;
}

/** Round to the nearest integer, preserving sign symmetry (Math.round alone
 * rounds -2.5 to -2 but 2.5 to 3, which produces visibly lopsided tick sets
 * around zero). */
function roundSym(v) {
  return Math.sign(v) * Math.round(Math.abs(v));
}

/** Widest rendered width among a set of label strings, in the ctx's current font. */
function measureMaxWidth(ctx, labels) {
  let w = 0;
  for (const l of labels) w = Math.max(w, ctx.measureText(l).width);
  return w;
}

/** Nearest "nice" 1-2-5 step for a numeric axis spanning `range`, aiming for ~targetCount ticks. */
function niceStep(range, targetCount = 5) {
  if (!(range > 0)) return 1;
  const rough = range / targetCount;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

/** Symmetric 1-2-5-stepped tick values covering [min, max]. */
function niceTicksSymmetric(min, max, targetCount = 5) {
  const step = niceStep(max - min, targetCount);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(roundSym(v));
  return [...new Set(ticks)];
}

// Degree-axis steps chosen so ticks land on angles that read naturally
// (45/90/180 etc.) rather than arbitrary 1-2-5 multiples.
const ANGLE_STEPS = [1, 2, 5, 10, 15, 30, 45, 90, 180, 360];
function angleStep(range, targetCount = 4) {
  for (const s of ANGLE_STEPS) {
    if (range / s <= targetCount) return s;
  }
  return ANGLE_STEPS[ANGLE_STEPS.length - 1];
}
/** Symmetric, degree-friendly tick values covering [min, max]. */
function angleTicks(min, max, targetCount = 4) {
  const step = angleStep(Math.max(1e-6, max - min), targetCount);
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(roundSym(v));
  return [...new Set(ticks)];
}

/**
 * Combined magnitude response of the currently applied filter chain: a hard
 * band-limit box (always active) and, when actuator lag is on, a first-order
 * lag on top of it. Matches the filtering done in updateReadouts() below.
 * @returns {number} 0..1
 */
function filterMagnitude(freq, bandwidth, useLag, fc) {
  if (Math.abs(freq) > bandwidth) return 0;
  if (!useLag) return 1;
  return 1 / Math.sqrt(1 + (freq / fc) ** 2);
}

/**
 * @param {HTMLCanvasElement} canvas - #joint-canvas
 * @param {ReturnType<typeof import('../core/store.js').createStore>} store
 * @returns {{render: (state: object, derived: object) => void, resize: () => void, destroy: () => void}}
 */
export function createJointPlot(canvas, store) {
  const canvasState = setupCanvas(canvas);

  const bandwidthEl = document.getElementById('bandwidth');
  const bandwidthValueEl = document.getElementById('bandwidth-value');
  const energyEl = document.getElementById('energy-readout');
  const trackingEl = document.getElementById('tracking-error');
  const feedbackEl = document.getElementById('feedback-toggle');
  const fcEl = document.getElementById('fc-slider');
  const fcValueEl = document.getElementById('fc-value');
  const angleModeEl = document.getElementById('angle-mode');
  const angleWrapEl = document.getElementById('angle-wrap');

  bandwidthEl.addEventListener('input', () => {
    const b = parseFloat(bandwidthEl.value);
    bandwidthValueEl.textContent = String(b);
    store.set({ bandwidth: b }, 'control');
  });
  bandwidthValueEl.textContent = bandwidthEl.value;

  function syncFcEnabled() {
    fcEl.disabled = !feedbackEl.checked;
  }
  fcEl.addEventListener('input', () => {
    fcValueEl.textContent = fcEl.value;
  });
  feedbackEl.addEventListener('change', syncFcEnabled);
  syncFcEnabled();

  function spectrumEntries(derived) {
    return Array.from(derived.spectrum.entries())
      .map(([freq, v]) => ({ freq, c: v.sum }))
      .sort((a, b) => a.freq - b.freq);
  }

  function updateReadouts(state, derived) {
    const entries = spectrumEntries(derived);
    const totalEnergy = entries.reduce((s, e) => s + e.c.re * e.c.re + e.c.im * e.c.im, 0);
    const useLag = feedbackEl.checked;
    const fc = Math.max(0.01, parseFloat(fcEl.value));
    const bandwidth = state.bandwidth;

    // The bandwidth limit always applies; actuator lag, when on, stacks on
    // top of it rather than replacing it.
    const bandLimited = entries.filter((e) => Math.abs(e.freq) <= bandwidth);
    const filtered = useLag ? lowpass(bandLimited, fc) : bandLimited;

    const capturedEnergy = filtered.reduce((s, e) => s + e.c.re * e.c.re + e.c.im * e.c.im, 0);
    const fraction = totalEnergy > 1e-12 ? capturedEnergy / totalEnergy : 1;
    energyEl.textContent = `${(fraction * 100).toFixed(1)}%`;

    const M = Math.max(1, Math.floor((derived.path ? derived.path.length : 0) / 2));
    if (derived.path && derived.path.length > 0) {
      let sumSq = 0;
      for (let n = 0; n < M; n += 1) {
        const t = n / M;
        const recon = idftEval(filtered, t);
        const dx = recon.re - derived.path[2 * n];
        const dy = recon.im - derived.path[2 * n + 1];
        sumSq += dx * dx + dy * dy;
      }
      trackingEl.textContent = Math.sqrt(sumSq / M).toFixed(4);
    } else {
      // No components at all: there is no path to compare against.
      trackingEl.textContent = '—';
    }

    return { entries, filtered, bandwidth, useLag, fc };
  }

  /** Small right-aligned color-swatch legend, drawn in the same band as the panel title. */
  function drawLegend(ctx, x0, y0, panelW, items) {
    ctx.save();
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const swatch = 8;
    const labelGap = 4;
    const itemGap = 12;
    const widths = items.map((it) => swatch + labelGap + ctx.measureText(it.label).width);
    const totalW = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
    const rightPad = 4; // keeps the last label's text from touching/clipping at the canvas edge
    let x = x0 + panelW - totalW - rightPad;
    items.forEach((it, i) => {
      ctx.fillStyle = it.color;
      ctx.fillRect(x, y0 + 2, swatch, swatch);
      ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
      ctx.fillText(it.label, x + swatch + labelGap, y0);
      x += widths[i] + itemGap;
    });
    ctx.restore();
  }

  function drawAxes(ctx, x0, y0, panelW, panelH, { xTicks, yTicks }) {
    ctx.save();
    ctx.strokeStyle = cssVar('--divider-color', '#475569');
    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    xTicks.forEach((tick, i) => {
      const px = Math.round(tick.x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, y0 + panelH);
      ctx.lineTo(px, y0 + panelH + 4);
      ctx.stroke();
      // The first/last tick sits right at the plot's edge; centering its
      // label there clips half of it against the canvas edge, so anchor the
      // very first/last tick inward instead (left/right) and only center
      // the ones in between.
      ctx.textBaseline = 'top';
      if (i === 0) {
        ctx.textAlign = 'left';
        ctx.fillText(tick.label, px, y0 + panelH + 5);
      } else if (i === xTicks.length - 1) {
        ctx.textAlign = 'right';
        ctx.fillText(tick.label, px, y0 + panelH + 5);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(tick.label, px, y0 + panelH + 5);
      }
    });
    for (const tick of yTicks) {
      const py = Math.round(tick.y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0 - 4, py);
      ctx.lineTo(x0, py);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(tick.label, x0 - 6, py);
    }
    ctx.restore();
  }

  function drawThetaPanel(ctx, x0, y0, panelW, panelH, state, filteredComponents) {
    // Plot the FILTERED arm (the band-limited + lagged components actually
    // shown in the Control arm canvas), not the raw unfiltered components —
    // otherwise turning actuator lag on would have no visible effect here.
    const components = Array.isArray(filteredComponents) ? filteredComponents : state.components;
    const mode = angleModeEl && angleModeEl.value === 'rel' ? 'rel' : 'abs';
    const wrap = Boolean(angleWrapEl && angleWrapEl.checked);

    const TITLE_H = 14;
    const TICK_H = 16;
    const plotTop = y0 + TITLE_H;
    const plotBottom = y0 + panelH - TICK_H;
    const innerH = Math.max(1, plotBottom - plotTop);

    ctx.save();

    // Title lives in its own band above the plot area so it never overlaps
    // the traces (which can run right up to the top of the panel).
    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = mode === 'rel' ? 'q_k(t)' : 'θ_k(t)';
    // +2px: the theta glyph's left-side bearing otherwise clips against x0
    // when the panel starts flush with the canvas edge (x0 = 0).
    ctx.fillText(`${label}${wrap ? ' (wrapped)' : ''} — joint angle (filtered arm) vs t`, x0 + 2, y0);

    if (components.length === 0) {
      ctx.strokeStyle = cssVar('--border-color', '#334155');
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, plotTop, panelW, innerH);
      ctx.restore();
      return;
    }

    // Sample joint angles (degrees) across one period to auto-fit the y-axis.
    const series = components.map(() => new Array(THETA_SAMPLES));
    let minA = Infinity;
    let maxA = -Infinity;
    for (let i = 0; i < THETA_SAMPLES; i += 1) {
      const t = i / (THETA_SAMPLES - 1);
      const { abs, rel } = jointAngles(components, t);
      const raw = mode === 'rel' ? rel : abs;
      for (let k = 0; k < components.length; k += 1) {
        let deg = raw[k] * RAD2DEG;
        if (wrap) deg = wrapDeg180(deg);
        series[k][i] = deg;
        if (deg < minA) minA = deg;
        if (deg > maxA) maxA = deg;
      }
    }
    if (!Number.isFinite(minA) || !Number.isFinite(maxA) || maxA - minA < 1e-6) {
      minA -= 1;
      maxA += 1;
    }
    const pad = (maxA - minA) * 0.08;
    minA -= pad;
    maxA += pad;

    const yTickVals = angleTicks(minA, maxA, 4);
    ctx.font = '10px sans-serif';
    const yLabelW = Math.max(24, measureMaxWidth(ctx, yTickVals.map((v) => `${v}°`)) + 10);

    const plotL = x0 + yLabelW;
    const plotW = Math.max(1, x0 + panelW - plotL - 8);
    const toX = (t) => plotL + t * plotW;
    const toY = (a) => plotBottom - ((a - minA) / (maxA - minA)) * innerH;

    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotTop, plotW, innerH);

    for (let k = 0; k < components.length; k += 1) {
      ctx.strokeStyle = components[k].color || cssVar('--primary-color', '#00693e');
      ctx.lineWidth = 2;
      ctx.beginPath();
      let lastY = null;
      for (let i = 0; i < THETA_SAMPLES; i += 1) {
        const t = i / (THETA_SAMPLES - 1);
        const px = toX(t);
        const py = toY(series[k][i]);
        // When wrapped, a jump from +180 to -180 is a display artifact, not a
        // real discontinuity — break the line there instead of drawing a chord.
        if (wrap && lastY !== null && Math.abs(series[k][i] - series[k][i - 1]) > 180) {
          ctx.moveTo(px, py);
        } else if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
        lastY = py;
      }
      ctx.stroke();
    }

    // Time cursor: a neutral, desaturated color distinct from any trace color.
    const cursorX = toX(state.t);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = cssVar('--text-primary', '#f1f5f9');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursorX, plotTop);
    ctx.lineTo(cursorX, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes: t on x (0..1), angle (deg, nice/symmetric ticks) on y.
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ x: toX(t), label: t.toFixed(2) }));
    const yTicks = yTickVals.map((v) => ({ y: toY(v), label: `${v}°` }));
    drawAxes(ctx, plotL, plotTop, plotW, innerH, { xTicks, yTicks });

    ctx.restore();
  }

  function drawSpectrumPanel(ctx, x0, y0, panelW, panelH, info) {
    const { entries, bandwidth, useLag, fc } = info;

    const TITLE_H = 14;
    const TICK_H = 16;
    const plotTop = y0 + TITLE_H;
    const plotBottom = y0 + panelH - TICK_H;

    ctx.save();

    // Title in its own band above the plot area (was previously drawn inside
    // the plot, top-right, where it could overlap bars/curve near the edge).
    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const title = useLag ? 'Spectrum |c_f| + filtered + |H(f)| (band-limit × lag)' : 'Spectrum |c_f| + filtered + |H(f)| (band-limit)';
    ctx.fillText(title, x0, y0);

    if (entries.length === 0) {
      ctx.strokeStyle = cssVar('--border-color', '#334155');
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, plotTop, panelW, Math.max(1, plotBottom - plotTop));
      ctx.restore();
      return;
    }
    const maxFreq = entries.reduce((m, e) => Math.max(m, Math.abs(e.freq)), 1);
    const F = Math.max(maxFreq, bandwidth) + 2;
    const maxMag = entries.reduce((m, e) => Math.max(m, Math.hypot(e.c.re, e.c.im)), 1e-9);

    ctx.font = '10px sans-serif';
    const yLabelW = Math.max(24, measureMaxWidth(ctx, ['0', '0.5', 'max']) + 10);
    const plotL = x0 + yLabelW;
    const plotW = Math.max(1, x0 + panelW - plotL - 8);
    const plotH = Math.max(1, plotBottom - plotTop);
    const toX = (f) => plotL + ((f + F) / (2 * F)) * plotW;
    const clampX = (x) => Math.max(plotL, Math.min(plotL + plotW, x));
    const barW = Math.max(2, plotW / (2 * F) - 1);

    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotTop, plotW, plotH);

    // Passband / filter shading (clamped so it never overflows the panel).
    ctx.fillStyle = cssVar('--passband-fill', 'rgba(16, 185, 129, 0.15)');
    const bx0 = clampX(toX(-bandwidth));
    const bx1 = clampX(toX(bandwidth));
    ctx.fillRect(bx0, plotTop, bx1 - bx0, plotH);

    // Original |c_f| bars (muted).
    ctx.fillStyle = cssVar('--divider-color', '#475569');
    for (const e of entries) {
      const mag = Math.hypot(e.c.re, e.c.im);
      const h = (mag / maxMag) * plotH;
      const px = toX(e.freq);
      ctx.fillRect(px - barW / 2, plotBottom - h, barW, h);
    }

    // Filtered bars (surviving magnitude), overlaid narrower and accent-colored.
    ctx.fillStyle = cssVar('--primary-color', '#00693e');
    for (const e of entries) {
      const mag = Math.hypot(e.c.re, e.c.im) * filterMagnitude(e.freq, bandwidth, useLag, fc);
      if (mag <= 1e-9) continue;
      const h = (mag / maxMag) * plotH;
      const px = toX(e.freq);
      ctx.fillRect(px - barW / 4, plotBottom - h, barW / 2, h);
    }

    // |H(f)| overlay curve (band-limit box, optionally combined with the lag).
    ctx.strokeStyle = cssVar('--accent-color', '#ffa00f');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    const steps = 200;
    for (let i = 0; i <= steps; i += 1) {
      const f = -F + (2 * F * i) / steps;
      const h = filterMagnitude(f, bandwidth, useLag, fc);
      const px = toX(f);
      const py = plotBottom - h * plotH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes: f on x (nice, symmetric 1-2-5 steps), magnitude on y (0..max as a
    // fraction of the largest |c_f|).
    const xTickVals = niceTicksSymmetric(-F, F, 4);
    const xTicks = xTickVals.map((f) => ({ x: toX(f), label: String(f) }));
    const yTicks = [0, 0.5, 1].map((frac) => ({ y: plotBottom - frac * plotH, label: frac === 1 ? 'max' : String(frac) }));
    drawAxes(ctx, plotL, plotTop, plotW, plotH, { xTicks, yTicks });
    ctx.restore();
  }

  // -- Gesture mode: main-chain joint angles + per-joint harmonic spectrum --

  function drawThetaPanelGesture(ctx, x0, y0, panelW, panelH, state, filteredBones) {
    const bones = filteredBones || (state.gesture && state.gesture.bones) || [];
    const mode = angleModeEl && angleModeEl.value === 'rel' ? 'rel' : 'abs';
    const wrap = Boolean(angleWrapEl && angleWrapEl.checked);

    const TITLE_H = 14;
    const TICK_H = 16;
    const plotTop = y0 + TITLE_H;
    const plotBottom = y0 + panelH - TICK_H;
    const innerH = Math.max(1, plotBottom - plotTop);

    ctx.save();
    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = mode === 'rel' ? 'q_k(t)' : 'θ_k(t)';
    ctx.fillText(`${label}${wrap ? ' (wrapped)' : ''} — main-chain joint angle (filtered) vs t`, x0 + 2, y0);

    const byId = new Map((state.gesture ? state.gesture.bones : []).map((b) => [b.id, b]));
    const JOINT_LEGEND_LABELS = { upperArm: 'upper arm', forearm: 'forearm', palm: 'hand' };
    drawLegend(ctx, x0, y0, panelW, MAIN_JOINT_IDS.map((id) => ({
      label: JOINT_LEGEND_LABELS[id] || id,
      color: (byId.get(id) || {}).color || cssVar('--primary-color', '#00693e'),
    })));

    if (bones.length === 0) {
      ctx.strokeStyle = cssVar('--border-color', '#334155');
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, plotTop, panelW, innerH);
      ctx.restore();
      return;
    }

    const series = MAIN_JOINT_IDS.map(() => new Array(THETA_SAMPLES));
    let minA = Infinity;
    let maxA = -Infinity;
    for (let i = 0; i < THETA_SAMPLES; i += 1) {
      const t = i / (THETA_SAMPLES - 1);
      const fk = forwardKinematics(bones, t);
      MAIN_JOINT_IDS.forEach((id, k) => {
        const j = fk.get(id);
        let deg = (mode === 'rel' ? j.relAngle : j.absAngle) * RAD2DEG;
        if (wrap) deg = wrapDeg180(deg);
        series[k][i] = deg;
        if (deg < minA) minA = deg;
        if (deg > maxA) maxA = deg;
      });
    }
    if (!Number.isFinite(minA) || !Number.isFinite(maxA) || maxA - minA < 1e-6) {
      minA -= 1;
      maxA += 1;
    }
    const pad = (maxA - minA) * 0.08;
    minA -= pad;
    maxA += pad;

    const yTickVals = angleTicks(minA, maxA, 4);
    ctx.font = '10px sans-serif';
    const yLabelW = Math.max(24, measureMaxWidth(ctx, yTickVals.map((v) => `${v}°`)) + 10);
    const plotL = x0 + yLabelW;
    const plotW = Math.max(1, x0 + panelW - plotL - 8);
    const toX = (t) => plotL + t * plotW;
    const toY = (a) => plotBottom - ((a - minA) / (maxA - minA)) * innerH;

    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotTop, plotW, innerH);

    MAIN_JOINT_IDS.forEach((id, k) => {
      ctx.strokeStyle = (byId.get(id) || {}).color || cssVar('--primary-color', '#00693e');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < THETA_SAMPLES; i += 1) {
        const px = toX(i / (THETA_SAMPLES - 1));
        const py = toY(series[k][i]);
        if (wrap && i > 0 && Math.abs(series[k][i] - series[k][i - 1]) > 180) ctx.moveTo(px, py);
        else if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    });

    const cursorX = toX(state.t);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = cssVar('--text-primary', '#f1f5f9');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursorX, plotTop);
    ctx.lineTo(cursorX, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ x: toX(t), label: t.toFixed(2) }));
    const yTicks = yTickVals.map((v) => ({ y: toY(v), label: `${v}°` }));
    drawAxes(ctx, plotL, plotTop, plotW, innerH, { xTicks, yTicks });
    ctx.restore();
  }

  /** Per-harmonic amplitude "spectrum" for the main-chain joints, plus the
   * passband/lag filter overlay — the joint-space analogue of drawSpectrumPanel. */
  function drawSpectrumPanelGesture(ctx, x0, y0, panelW, panelH, state) {
    const bones = (state.gesture ? state.gesture.bones : []).filter((b) => MAIN_JOINT_IDS.includes(b.id));
    const bandwidth = state.bandwidth;
    const feedbackEl2 = document.getElementById('feedback-toggle');
    const fcEl2 = document.getElementById('fc-slider');
    const useLag = feedbackEl2 && feedbackEl2.checked;
    const fc = Math.max(0.01, parseFloat(fcEl2.value));

    const TITLE_H = 14;
    const TICK_H = 16;
    const plotTop = y0 + TITLE_H;
    const plotBottom = y0 + panelH - TICK_H;
    const plotH = Math.max(1, plotBottom - plotTop);

    ctx.save();
    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Main-chain joint harmonics |a_h| (deg) — band-limit × lag', x0 + 2, y0);

    const F = 4; // H <= 4
    ctx.font = '10px sans-serif';
    const yLabelW = Math.max(24, measureMaxWidth(ctx, ['0', '0.5', 'max']) + 10);
    const plotL = x0 + yLabelW;
    const plotW = Math.max(1, x0 + panelW - plotL - 8);
    const toX = (hIdx) => plotL + ((hIdx + 0.5) / (F + 1)) * plotW;
    const barW = Math.max(4, plotW / (F + 1) / (MAIN_JOINT_IDS.length + 1));

    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotTop, plotW, plotH);

    let maxAmpDeg = 1e-6;
    for (const b of bones) for (const hm of b.series.harmonics) maxAmpDeg = Math.max(maxAmpDeg, hm.amp * RAD2DEG);

    // Passband shading (harmonics 1..B survive).
    if (bandwidth > 0) {
      ctx.fillStyle = cssVar('--passband-fill', 'rgba(16, 185, 129, 0.15)');
      const bx0 = toX(0.5);
      const bx1 = toX(Math.min(F, bandwidth) + 0.5);
      ctx.fillRect(bx0, plotTop, Math.max(0, bx1 - bx0), plotH);
    }

    bones.forEach((b, bi) => {
      for (const hm of b.series.harmonics) {
        const offset = (bi - (bones.length - 1) / 2) * barW;
        const px = toX(hm.h) + offset;
        const magOriginal = (hm.amp * RAD2DEG) / maxAmpDeg;
        ctx.fillStyle = cssVar('--divider-color', '#475569');
        ctx.fillRect(px - barW / 2, plotBottom - magOriginal * plotH, barW, magOriginal * plotH);
        const survives = hm.h <= bandwidth;
        if (survives) {
          const magFiltered = survives ? magOriginal * filterMagnitude(hm.h, bandwidth, useLag, fc) : 0;
          ctx.fillStyle = b.color || cssVar('--primary-color', '#00693e');
          ctx.fillRect(px - barW / 4, plotBottom - magFiltered * plotH, barW / 2, magFiltered * plotH);
        }
      }
    });

    const xTickVals = [0, 1, 2, 3, 4];
    const xTicks = xTickVals.map((hIdx) => ({ x: toX(hIdx), label: hIdx === 0 ? 'mean' : `h${hIdx}` }));
    const yTicks = [0, 0.5, 1].map((frac) => ({ y: plotBottom - frac * plotH, label: frac === 1 ? 'max' : String(frac) }));
    drawAxes(ctx, plotL, plotTop, plotW, plotH, { xTicks, yTicks });
    ctx.restore();
  }

  function updateReadoutsGesture(state, filteredBones) {
    const rawBones = (state.gesture && state.gesture.bones) || [];
    const bones = filteredBones || rawBones;
    const mainRaw = rawBones.filter((b) => MAIN_JOINT_IDS.includes(b.id));
    const mainFiltered = bones.filter((b) => MAIN_JOINT_IDS.includes(b.id));
    let totalPower = 0;
    let capturedPower = 0;
    mainRaw.forEach((b, i) => {
      for (const hm of b.series.harmonics) totalPower += hm.amp * hm.amp;
      const filteredBone = mainFiltered[i];
      if (filteredBone) for (const hm of filteredBone.series.harmonics) capturedPower += hm.amp * hm.amp;
    });
    const fraction = totalPower > 1e-12 ? capturedPower / totalPower : 1;
    energyEl.textContent = `${(fraction * 100).toFixed(1)}%`;

    if (rawBones.length > 0) {
      const M = 200;
      const rawPath = sampleTipPath(rawBones, 'middle3', M);
      const filteredPath = sampleTipPath(bones, 'middle3', M);
      let sumSq = 0;
      for (let n = 0; n < M; n += 1) {
        const dx = filteredPath[2 * n] - rawPath[2 * n];
        const dy = filteredPath[2 * n + 1] - rawPath[2 * n + 1];
        sumSq += dx * dx + dy * dy;
      }
      trackingEl.textContent = Math.sqrt(sumSq / M).toFixed(4);
    } else {
      trackingEl.textContent = '—';
    }
  }

  function render(state, derived, filteredComponents, filteredBones) {
    const { ctx, w, h } = canvasState;
    ctx.clearRect(0, 0, w, h);

    const gap = 12;
    const thetaH = Math.round(h * 0.55);
    const spectrumH = h - thetaH - gap;

    if (state.motion === 'gesture') {
      drawThetaPanelGesture(ctx, 0, 0, w, thetaH, state, filteredBones);
      updateReadoutsGesture(state, filteredBones);
      drawSpectrumPanelGesture(ctx, 0, thetaH + gap, w, spectrumH, state);
      return;
    }

    drawThetaPanel(ctx, 0, 0, w, thetaH, state, filteredComponents);
    const info = updateReadouts(state, derived);
    drawSpectrumPanel(ctx, 0, thetaH + gap, w, spectrumH, info);
  }

  function resize() {
    // setupCanvas keeps the backing store sized via ResizeObserver.
  }

  function destroy() {
    canvasState.destroy();
  }

  return { render, resize, destroy };
}
