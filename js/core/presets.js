/**
 * Built-in shape presets. Each preset returns a normalized list of
 * amp/phase/freq components (no id/color — the store assigns those).
 * @module core/presets
 */

import { resampleArcLength, dft, topK, fromCoeff } from './fourier.js';

/** Names accepted by {@link preset}. */
export const PRESET_NAMES = ['arm', 'circle', 'ellipse', 'square', 'sawtooth', 'star', 'heart'];

const SAMPLE_POINTS = 1000;
const RESAMPLE_N = 512;

function squarePath(u) {
  const perim = u * 8;
  const side = Math.floor(perim / 2) % 4;
  const local = perim % 2;
  switch (side) {
    case 0:
      return { x: -1 + local, y: -1 };
    case 1:
      return { x: 1, y: -1 + local };
    case 2:
      return { x: 1 - local, y: 1 };
    default:
      return { x: -1, y: 1 - local };
  }
}

function sawtoothPath(u) {
  const teeth = 8;
  const theta = 2 * Math.PI * u;
  const frac = (teeth * u) % 1;
  const r = 0.6 + 0.4 * frac;
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

function starPath(u) {
  const points = 5;
  const theta = 2 * Math.PI * u;
  const outer = 1;
  const inner = 0.4;
  const phase = (points * u) % 1;
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  const r = inner + (outer - inner) * tri;
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

function heartPath(u) {
  const t = 2 * Math.PI * u;
  const x = 16 * Math.pow(Math.sin(t), 3);
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return { x: x / 16, y: y / 16 };
}

function normalize(components) {
  const sum = components.reduce((s, c) => s + c.amp, 0);
  if (sum < 1e-12) return components;
  return components.map((c) => ({ ...c, amp: c.amp / sum }));
}

// Below this magnitude, a shape's DC (freq=0) term is treated as noise from
// sampling/resampling rather than a real offset, and dropped so topK doesn't
// waste one of the n requested components on a near-zero-amplitude link.
const DC_EPS = 1e-4;

function fromShape(pathFn, n) {
  const pts = [];
  for (let i = 0; i < SAMPLE_POINTS; i++) pts.push(pathFn(i / SAMPLE_POINTS));
  const z = resampleArcLength(pts, RESAMPLE_N, true);
  const coeffs = dft(z);
  const dc = coeffs.find((c) => c.freq === 0);
  const usable = dc && Math.hypot(dc.c.re, dc.c.im) < DC_EPS ? coeffs.filter((c) => c.freq !== 0) : coeffs;
  const top = topK(usable, n);
  return normalize(top.map((c) => fromCoeff(c)));
}

/**
 * Build a preset shape's component list.
 * @param {'circle'|'ellipse'|'square'|'sawtooth'|'star'|'heart'} name
 * @param {number} [n=15] - number of components to keep (ignored by circle/ellipse)
 * @returns {{freq:number, amp:number, phase:number}[]}
 */
export function preset(name, n = 15) {
  switch (name) {
    case 'arm':
      // A relaxed human arm reaching to the right: shoulder -> upper arm ->
      // forearm -> hand -> finger -> fingertip, each link a Fourier
      // component (freq = spin rate, amp = link length, phase = angle at
      // t=0). Phases droop gently from the shoulder so the t=0 pose reads as
      // a natural, relaxed reach with loosely curled fingers. Amplitudes
      // already sum to 1.
      return [
        { label: 'Upper arm', freq: 1, amp: 0.36, phase: -0.1 },
        { label: 'Forearm', freq: 2, amp: 0.3, phase: -0.35 },
        { label: 'Hand', freq: -3, amp: 0.16, phase: -0.7 },
        { label: 'Finger', freq: 4, amp: 0.11, phase: -1.05 },
        { label: 'Fingertip', freq: -5, amp: 0.07, phase: -1.5 },
      ];
    case 'circle':
      return normalize([{ freq: 1, amp: 1, phase: 0 }]);
    case 'ellipse':
      return normalize([
        { freq: 1, amp: 0.75, phase: 0 },
        { freq: -1, amp: 0.25, phase: 0 },
      ]);
    case 'square':
      return fromShape(squarePath, n);
    case 'sawtooth':
      return fromShape(sawtoothPath, n);
    case 'star':
      return fromShape(starPath, n);
    case 'heart':
      return fromShape(heartPath, n);
    default:
      throw new Error(`Unknown preset: ${name}`);
  }
}
