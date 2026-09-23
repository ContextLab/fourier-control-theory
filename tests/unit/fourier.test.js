import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleArcLength,
  dft,
  idftEval,
  topK,
  sampleSeries,
  lowpass,
  toCoeff,
  fromCoeff,
} from '../../js/core/fourier.js';

function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b} (eps ${eps})`);
}

function randomSignal(N, seed = 1) {
  // deterministic pseudo-random signal (no external deps)
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const z = [];
  for (let n = 0; n < N; n++) z.push({ re: rand() - 0.5, im: rand() - 0.5 });
  return z;
}

// --- resampleArcLength -------------------------------------------------

test('resampleArcLength always returns exactly N points', () => {
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push({ x: Math.cos((2 * Math.PI * i) / 20), y: Math.sin((2 * Math.PI * i) / 20) });
  const z = resampleArcLength(pts, 100, true);
  assert.equal(z.length, 100);
});

test('resampleArcLength spacing is uniform for a closed circle', () => {
  const pts = [];
  const M = 37;
  for (let i = 0; i < M; i++) pts.push({ x: Math.cos((2 * Math.PI * i) / M), y: Math.sin((2 * Math.PI * i) / M) });
  const N = 64;
  const z = resampleArcLength(pts, N, true);
  assert.equal(z.length, N);
  const seg0 = Math.hypot(z[1].re - z[0].re, z[1].im - z[0].im);
  for (let n = 1; n < N; n++) {
    const next = (n + 1) % N;
    const seg = Math.hypot(z[next].re - z[n].re, z[next].im - z[n].im);
    close(seg, seg0, 1e-3);
  }
});

test('resampleArcLength drops consecutive duplicate points without producing NaN', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const z = resampleArcLength(pts, 40, true);
  assert.equal(z.length, 40);
  for (const p of z) {
    assert.ok(Number.isFinite(p.re) && Number.isFinite(p.im));
  }
});

test('resampleArcLength handles an open curve, sampling endpoints inclusively', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ];
  const N = 10;
  const z = resampleArcLength(pts, N, false);
  assert.equal(z.length, N);
  close(z[0].re, 0);
  close(z[0].im, 0);
  close(z[N - 1].re, 1);
  close(z[N - 1].im, 1);
});

test('resampleArcLength on a single distinct point returns that point everywhere', () => {
  const pts = [
    { x: 2, y: 3 },
    { x: 2, y: 3 },
    { x: 2, y: 3 },
  ];
  const z = resampleArcLength(pts, 5, true);
  for (const p of z) {
    close(p.re, 2);
    close(p.im, 3);
  }
});

// --- dft / idftEval ------------------------------------------------------

test('dft -> idftEval round-trips a random signal at the sample points', () => {
  const N = 32;
  const z = randomSignal(N, 7);
  const coeffs = dft(z);
  assert.equal(coeffs.length, N);
  for (let n = 0; n < N; n++) {
    const t = n / N;
    const rec = idftEval(coeffs, t);
    close(rec.re, z[n].re, 1e-6);
    close(rec.im, z[n].im, 1e-6);
  }
});

test('dft of a pure tone concentrates all energy at that frequency', () => {
  const N = 16;
  const f0 = 3;
  const z = [];
  for (let n = 0; n < N; n++) {
    const theta = (2 * Math.PI * f0 * n) / N;
    z.push({ re: Math.cos(theta), im: Math.sin(theta) });
  }
  const coeffs = dft(z);
  for (const { freq, c } of coeffs) {
    const mag = Math.hypot(c.re, c.im);
    if (freq === f0) {
      close(mag, 1, 1e-6);
    } else {
      close(mag, 0, 1e-6);
    }
  }
});

test('dft is linear', () => {
  const N = 16;
  const x = randomSignal(N, 3);
  const y = randomSignal(N, 11);
  const a = 2.5;
  const b = -1.5;
  const combined = x.map((xi, n) => ({ re: a * xi.re + b * y[n].re, im: a * xi.im + b * y[n].im }));
  const dCombined = dft(combined);
  const dx = dft(x);
  const dy = dft(y);
  for (let i = 0; i < N; i++) {
    const expectedRe = a * dx[i].c.re + b * dy[i].c.re;
    const expectedIm = a * dx[i].c.im + b * dy[i].c.im;
    close(dCombined[i].c.re, expectedRe, 1e-6);
    close(dCombined[i].c.im, expectedIm, 1e-6);
  }
});

test('dft satisfies Parseval: mean(|z|^2) == sum(|c_f|^2)', () => {
  const N = 24;
  const z = randomSignal(N, 42);
  const coeffs = dft(z);
  let timeEnergy = 0;
  for (const zn of z) timeEnergy += zn.re * zn.re + zn.im * zn.im;
  timeEnergy /= N;
  let freqEnergy = 0;
  for (const { c } of coeffs) freqEnergy += c.re * c.re + c.im * c.im;
  close(timeEnergy, freqEnergy, 1e-6);
});

// --- topK ------------------------------------------------------------

test('topK always keeps DC (freq 0) first, then sorts the rest by magnitude descending', () => {
  const coeffs = [
    { freq: 0, c: { re: 0.01, im: 0 } }, // tiny DC, must still be kept & first
    { freq: 1, c: { re: 0.5, im: 0 } },
    { freq: -1, c: { re: 0.9, im: 0 } },
    { freq: 2, c: { re: 0.2, im: 0 } },
  ];
  const top = topK(coeffs, 3);
  assert.equal(top.length, 3);
  assert.equal(top[0].freq, 0);
  const mags = top.slice(1).map((e) => Math.hypot(e.c.re, e.c.im));
  assert.ok(mags[0] >= mags[1]);
  assert.equal(top[1].freq, -1);
  assert.equal(top[2].freq, 1);
});

test('topK with K larger than the input returns everything', () => {
  const coeffs = [
    { freq: 1, c: { re: 1, im: 0 } },
    { freq: 2, c: { re: 2, im: 0 } },
  ];
  assert.equal(topK(coeffs, 10).length, 2);
});

// --- sampleSeries ------------------------------------------------------

test('sampleSeries returns a Float32Array of length 2M', () => {
  const components = [{ freq: 1, amp: 1, phase: 0 }];
  const out = sampleSeries(components, 250);
  assert.ok(out instanceof Float32Array);
  assert.equal(out.length, 500);
});

test('sampleSeries matches a manual evaluation of the epicycle sum', () => {
  const components = [
    { freq: 1, amp: 1, phase: 0 },
    { freq: 2, amp: 0.5, phase: Math.PI / 4 },
  ];
  const M = 8;
  const out = sampleSeries(components, M);
  for (let m = 0; m < M; m++) {
    const t = m / M;
    let ex = 0;
    let ey = 0;
    for (const c of components) {
      const theta = 2 * Math.PI * c.freq * t + c.phase;
      ex += c.amp * Math.cos(theta);
      ey += c.amp * Math.sin(theta);
    }
    close(out[2 * m], ex, 1e-4);
    close(out[2 * m + 1], ey, 1e-4);
  }
});

// --- lowpass ------------------------------------------------------

test('lowpass attenuates by 1/sqrt(2) exactly at the cutoff frequency', () => {
  const fc = 5;
  const coeffs = [{ freq: fc, c: { re: 1, im: 0 } }];
  const filtered = lowpass(coeffs, fc);
  const mag = Math.hypot(filtered[0].c.re, filtered[0].c.im);
  close(mag, 1 / Math.sqrt(2), 1e-9);
});

test('lowpass leaves DC (f=0) unattenuated', () => {
  const coeffs = [{ freq: 0, c: { re: 2, im: -1 } }];
  const filtered = lowpass(coeffs, 5);
  close(filtered[0].c.re, 2);
  close(filtered[0].c.im, -1);
});

test('lowpass strongly attenuates frequencies far above cutoff', () => {
  const fc = 1;
  const coeffs = [{ freq: 100, c: { re: 1, im: 0 } }];
  const filtered = lowpass(coeffs, fc);
  const mag = Math.hypot(filtered[0].c.re, filtered[0].c.im);
  assert.ok(mag < 0.02);
});

// --- toCoeff / fromCoeff ------------------------------------------------------

test('toCoeff / fromCoeff round-trip a component', () => {
  const comp = { freq: 3, amp: 1.7, phase: -0.9, id: 5, color: '#fff' };
  const c = toCoeff(comp);
  const back = fromCoeff({ freq: comp.freq, c }, { id: comp.id, color: comp.color });
  close(back.amp, comp.amp);
  close(back.phase, comp.phase);
  assert.equal(back.freq, comp.freq);
  assert.equal(back.id, comp.id);
  assert.equal(back.color, comp.color);
});
