// theta_k(t) plot + control-theory overlays: bandwidth truncation, mini Bode,
// first-order actuator-lag feedback filter.
import { setupCanvas, cssVar } from './canvas.js';
import { jointAngles } from '../core/arm.js';
import { lowpass, idftEval } from '../core/fourier.js';

const THETA_SAMPLES = 200;

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

  bandwidthEl.addEventListener('input', () => {
    const b = parseFloat(bandwidthEl.value);
    bandwidthValueEl.textContent = String(b);
    store.set({ bandwidth: b }, 'control');
  });
  bandwidthValueEl.textContent = bandwidthEl.value;

  fcEl.addEventListener('input', () => {
    fcValueEl.textContent = fcEl.value;
  });

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

    let filtered;
    if (useLag) {
      filtered = lowpass(entries, fc);
    } else {
      filtered = entries.filter((e) => Math.abs(e.freq) <= bandwidth);
    }

    const capturedEnergy = filtered.reduce((s, e) => s + e.c.re * e.c.re + e.c.im * e.c.im, 0);
    const fraction = totalEnergy > 1e-12 ? capturedEnergy / totalEnergy : 1;
    energyEl.textContent = `${(fraction * 100).toFixed(1)}%`;

    const M = Math.max(1, Math.floor((derived.path ? derived.path.length : 0) / 2));
    if (M > 0 && filtered.length > 0) {
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
      trackingEl.textContent = '—';
    }

    return { entries, filtered, bandwidth, useLag };
  }

  function drawThetaPanel(ctx, x0, y0, panelW, panelH, state) {
    const components = state.components;
    ctx.save();
    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, panelW, panelH);

    if (components.length === 0) {
      ctx.restore();
      return;
    }

    // Sample abs joint angles across one period to auto-fit the y-axis.
    const series = components.map(() => new Array(THETA_SAMPLES));
    let minA = Infinity;
    let maxA = -Infinity;
    for (let i = 0; i < THETA_SAMPLES; i += 1) {
      const t = i / (THETA_SAMPLES - 1);
      const { abs } = jointAngles(components, t);
      for (let k = 0; k < components.length; k += 1) {
        series[k][i] = abs[k];
        if (abs[k] < minA) minA = abs[k];
        if (abs[k] > maxA) maxA = abs[k];
      }
    }
    if (!Number.isFinite(minA) || !Number.isFinite(maxA) || maxA - minA < 1e-6) {
      minA -= 1;
      maxA += 1;
    }
    const pad = (maxA - minA) * 0.08;
    minA -= pad;
    maxA += pad;

    const toX = (t) => x0 + t * panelW;
    const toY = (a) => y0 + panelH - ((a - minA) / (maxA - minA)) * panelH;

    for (let k = 0; k < components.length; k += 1) {
      ctx.strokeStyle = components[k].color || cssVar('--primary-color', '#00693e');
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < THETA_SAMPLES; i += 1) {
        const t = i / (THETA_SAMPLES - 1);
        const px = toX(t);
        const py = toY(series[k][i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Time cursor.
    const cursorX = toX(state.t);
    ctx.strokeStyle = cssVar('--accent-color', '#ffa00f');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cursorX, y0);
    ctx.lineTo(cursorX, y0 + panelH);
    ctx.stroke();

    ctx.fillStyle = cssVar('--text-muted', '#64748b');
    ctx.font = '11px sans-serif';
    ctx.fillText('θ_k(t), one period', x0 + 6, y0 + 14);
    ctx.restore();
  }

  function drawBodePanel(ctx, x0, y0, panelW, panelH, info) {
    ctx.save();
    ctx.strokeStyle = cssVar('--border-color', '#334155');
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, panelW, panelH);

    const { entries, bandwidth, useLag } = info;
    if (entries.length === 0) {
      ctx.restore();
      return;
    }
    const maxFreq = entries.reduce((m, e) => Math.max(m, Math.abs(e.freq)), 1);
    const F = Math.max(5, maxFreq + 2);
    const maxMag = entries.reduce((m, e) => Math.max(m, Math.hypot(e.c.re, e.c.im)), 1e-9);

    const toX = (f) => x0 + ((f + F) / (2 * F)) * panelW;
    const barW = Math.max(2, panelW / (2 * F) - 1);

    // Passband shading.
    if (!useLag) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
      const bx0 = toX(-bandwidth);
      const bx1 = toX(bandwidth);
      ctx.fillRect(bx0, y0, bx1 - bx0, panelH);
    }

    ctx.fillStyle = cssVar('--text-muted', '#64748b');
    for (const e of entries) {
      const mag = Math.hypot(e.c.re, e.c.im);
      const h = (mag / maxMag) * (panelH - 16);
      const px = toX(e.freq);
      ctx.fillRect(px - barW / 2, y0 + panelH - h, barW, h);
    }

    ctx.fillStyle = cssVar('--text-secondary', '#94a3b8');
    ctx.font = '11px sans-serif';
    ctx.fillText(useLag ? 'Bode |c_f| (lag filter active)' : 'Bode |c_f|, passband shaded', x0 + 6, y0 + 14);
    ctx.restore();
  }

  function render(state, derived) {
    const { ctx, w, h } = canvasState;
    ctx.clearRect(0, 0, w, h);

    const gap = 12;
    const thetaH = Math.round(h * 0.6);
    const bodeH = h - thetaH - gap;

    drawThetaPanel(ctx, 0, 0, w, thetaH, state);
    const info = updateReadouts(state, derived);
    drawBodePanel(ctx, 0, thetaH + gap, w, bodeH, info);
  }

  function resize() {
    // setupCanvas keeps the backing store sized via ResizeObserver.
  }

  function destroy() {
    canvasState.destroy();
  }

  return { render, resize, destroy };
}
