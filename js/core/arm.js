/**
 * Pure kinematics for the epicycle/robot-arm chain. A "component" is
 * `{id, freq, amp, phase, color}` (only freq/amp/phase are used here);
 * components are chained in array order, link k spinning at freq_k with
 * length amp_k and phase phase_k.
 * @module core/arm
 */

import { sampleSeries } from './fourier.js';

/**
 * Joint positions p_0..p_n at time t, where p_0 is the origin and
 * p_k = p_{k-1} + amp_k * e^{i(2π f_k t + φ_k)}.
 * @param {{freq:number, amp:number, phase:number}[]} components
 * @param {number} t
 * @param {{re:number, im:number}} [origin={re:0,im:0}]
 * @returns {{re:number, im:number}[]} length components.length + 1
 */
export function jointPositions(components, t, origin = { re: 0, im: 0 }) {
  const positions = [{ re: origin.re, im: origin.im }];
  let p = { re: origin.re, im: origin.im };
  for (const comp of components) {
    const theta = 2 * Math.PI * comp.freq * t + comp.phase;
    p = { re: p.re + comp.amp * Math.cos(theta), im: p.im + comp.amp * Math.sin(theta) };
    positions.push(p);
  }
  return positions;
}

/**
 * Joint angles at time t. Absolute angle θ_k = φ_k + 2π f_k t (unwrapped,
 * i.e. not reduced modulo 2π). Relative angle q_k = θ_k - θ_{k-1}, with
 * θ_{-1} taken to be 0 (so q_0 = θ_0).
 * @param {{freq:number, amp:number, phase:number}[]} components
 * @param {number} t
 * @returns {{abs:number[], rel:number[]}}
 */
export function jointAngles(components, t) {
  const abs = components.map((comp) => comp.phase + 2 * Math.PI * comp.freq * t);
  const rel = abs.map((theta, k) => theta - (k === 0 ? 0 : abs[k - 1]));
  return { abs, rel };
}

/**
 * Invert a drag of joint k's tip to point P at time t: solve for the
 * amp/phase of components[k] that would put the tip there, holding every
 * other component fixed. w = (P - p_{k-1}(t)) * e^{-i2πf_k t}; amp = |w|,
 * phase = arg(w). If the resulting amplitude is ~0 the phase is ambiguous,
 * so the component's previous phase is kept instead.
 * @param {{freq:number, amp:number, phase:number}[]} components
 * @param {number} k - 0-based index into components
 * @param {{re:number, im:number}} P - target point for the tip of link k
 * @param {number} t
 * @param {{re:number, im:number}} [origin={re:0,im:0}]
 * @returns {{amp:number, phase:number}}
 */
export function invertDrag(components, k, P, t, origin = { re: 0, im: 0 }) {
  const positions = jointPositions(components, t, origin);
  const base = positions[k];
  const comp = components[k];
  const diffRe = P.re - base.re;
  const diffIm = P.im - base.im;
  const theta = -2 * Math.PI * comp.freq * t;
  const cs = Math.cos(theta);
  const sn = Math.sin(theta);
  const wRe = diffRe * cs - diffIm * sn;
  const wIm = diffRe * sn + diffIm * cs;
  const amp = Math.hypot(wRe, wIm);
  const phase = amp < 1e-6 ? comp.phase : Math.atan2(wIm, wRe);
  return { amp, phase };
}

/**
 * Sample the end-effector path over one period. Identical to
 * `fourier.sampleSeries`.
 * @param {{freq:number, amp:number, phase:number}[]} components
 * @param {number} [M=1000]
 * @returns {Float32Array} length 2M, laid out as [x0,y0,x1,y1,...]
 */
export function pathSamples(components, M = 1000) {
  return sampleSeries(components, M);
}
