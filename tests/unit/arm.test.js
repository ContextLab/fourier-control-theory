import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jointPositions, jointAngles, invertDrag, pathSamples } from '../../js/core/arm.js';
import { idftEval, toCoeff, sampleSeries } from '../../js/core/fourier.js';

function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b} (eps ${eps})`);
}

const components = [
  { freq: 1, amp: 1, phase: 0.3 },
  { freq: -2, amp: 0.6, phase: 1.1 },
  { freq: 3, amp: 0.25, phase: -0.7 },
];

test('jointPositions returns components.length + 1 points, starting at origin', () => {
  const positions = jointPositions(components, 0.2);
  assert.equal(positions.length, components.length + 1);
  assert.deepEqual(positions[0], { re: 0, im: 0 });
});

test('jointPositions end effector matches idftEval of the equivalent coefficients', () => {
  const coeffs = components.map((c) => ({ freq: c.freq, c: toCoeff(c) }));
  for (const t of [0, 0.13, 0.5, 0.87]) {
    const positions = jointPositions(components, t);
    const end = positions[positions.length - 1];
    const expected = idftEval(coeffs, t);
    close(end.re, expected.re);
    close(end.im, expected.im);
  }
});

test('jointPositions with a nonzero origin offsets every joint by that origin', () => {
  const origin = { re: 5, im: -3 };
  const p0 = jointPositions(components, 0.4);
  const p1 = jointPositions(components, 0.4, origin);
  for (let i = 0; i < p0.length; i++) {
    close(p1[i].re, p0[i].re + origin.re);
    close(p1[i].im, p0[i].im + origin.im);
  }
});

test('pathSamples matches fourier.sampleSeries exactly', () => {
  const a = pathSamples(components, 64);
  const b = sampleSeries(components, 64);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// --- jointAngles ------------------------------------------------------

test('jointAngles.abs is linear in t with slope 2*pi*freq, offset by phase', () => {
  const t0 = 0.2;
  const t1 = 0.6;
  const a0 = jointAngles(components, t0).abs;
  const a1 = jointAngles(components, t1).abs;
  components.forEach((c, k) => {
    close(a0[k], c.phase + 2 * Math.PI * c.freq * t0);
    const slope = (a1[k] - a0[k]) / (t1 - t0);
    close(slope, 2 * Math.PI * c.freq, 1e-6);
  });
});

test('jointAngles.rel is the difference of consecutive absolute angles, with theta_{-1} = 0', () => {
  const t = 0.35;
  const { abs, rel } = jointAngles(components, t);
  close(rel[0], abs[0]);
  for (let k = 1; k < components.length; k++) {
    close(rel[k], abs[k] - abs[k - 1]);
  }
});

// --- invertDrag ------------------------------------------------------

test('invertDrag: after applying the result, the dragged tip lands exactly on P', () => {
  const t = 0.42;
  const k = 1;
  const P = { re: 2, im: -1.5 };
  const { amp, phase } = invertDrag(components, k, P, t);
  const patched = components.map((c, i) => (i === k ? { ...c, amp, phase } : c));
  const positions = jointPositions(patched, t);
  close(positions[k + 1].re, P.re);
  close(positions[k + 1].im, P.im);
});

test('invertDrag: upstream joints (before k) are unchanged', () => {
  const t = 0.42;
  const k = 1;
  const P = { re: 2, im: -1.5 };
  const before = jointPositions(components, t);
  const { amp, phase } = invertDrag(components, k, P, t);
  const patched = components.map((c, i) => (i === k ? { ...c, amp, phase } : c));
  const after = jointPositions(patched, t);
  for (let i = 0; i <= k; i++) {
    close(after[i].re, before[i].re);
    close(after[i].im, before[i].im);
  }
});

test('invertDrag: downstream joints are shifted by the same delta as the dragged joint', () => {
  const t = 0.42;
  const k = 1;
  const P = { re: 2, im: -1.5 };
  const before = jointPositions(components, t);
  const { amp, phase } = invertDrag(components, k, P, t);
  const patched = components.map((c, i) => (i === k ? { ...c, amp, phase } : c));
  const after = jointPositions(patched, t);
  const delta = { re: after[k + 1].re - before[k + 1].re, im: after[k + 1].im - before[k + 1].im };
  for (let i = k + 1; i < after.length; i++) {
    close(after[i].re - before[i].re, delta.re);
    close(after[i].im - before[i].im, delta.im);
  }
});

test('invertDrag is the identity when P is already the current tip position', () => {
  const t = 0.6;
  const k = 2;
  const positions = jointPositions(components, t);
  const P = positions[k + 1];
  const { amp, phase } = invertDrag(components, k, P, t);
  close(amp, components[k].amp, 1e-6);
  close(phase, components[k].phase, 1e-6);
});

test('invertDrag keeps the previous phase when the solved amplitude is ~0', () => {
  const t = 0.1;
  const k = 0;
  const positions = jointPositions(components, t);
  const P = positions[k]; // same as base -> zero-length link
  const { amp, phase } = invertDrag(components, k, P, t);
  close(amp, 0, 1e-6);
  assert.equal(phase, components[k].phase);
});
