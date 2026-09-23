/**
 * Pure Fourier-analysis helpers: arc-length resampling, DFT/inverse-DFT,
 * truncation, series sampling, and a first-order low-pass filter.
 * No DOM access; safe to import under Node.
 * @module core/fourier
 */

/**
 * Resample a polyline uniformly by arc length into exactly N points.
 * Consecutive duplicate points are dropped first. When `closed` is true the
 * curve is closed (p_{M-1} -> p_0) before measuring length and the N samples
 * are spaced periodically (s_n = n*L/N, so the seam is not duplicated). When
 * `closed` is false the curve is left open and the N samples are spaced
 * inclusively from the first to the last point (s_n = n*L/(N-1)).
 * @param {{x:number,y:number}[]} pts
 * @param {number} [N=512]
 * @param {boolean} [closed=true]
 * @returns {{re:number, im:number}[]} always length N
 */
export function resampleArcLength(pts, N = 512, closed = true) {
  const cleaned = [];
  for (const p of pts) {
    const last = cleaned[cleaned.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) {
      cleaned.push({ x: p.x, y: p.y });
    }
  }

  if (cleaned.length === 0) {
    const out = new Array(N);
    for (let n = 0; n < N; n++) out[n] = { re: 0, im: 0 };
    return out;
  }
  if (cleaned.length === 1) {
    const out = new Array(N);
    for (let n = 0; n < N; n++) out[n] = { re: cleaned[0].x, im: cleaned[0].y };
    return out;
  }

  const poly = cleaned.slice();
  if (closed) {
    const first = poly[0];
    const last = poly[poly.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-9) {
      poly.push({ x: first.x, y: first.y });
    }
  }

  const cum = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
  }
  const L = cum[cum.length - 1];

  const out = new Array(N);
  if (L < 1e-12) {
    for (let n = 0; n < N; n++) out[n] = { re: poly[0].x, im: poly[0].y };
    return out;
  }

  const denom = closed ? N : Math.max(N - 1, 1);
  for (let n = 0; n < N; n++) {
    const s = (n * L) / denom;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    let i = lo;
    if (i >= poly.length - 1) i = poly.length - 2;
    const segLen = cum[i + 1] - cum[i];
    const tt = segLen > 1e-12 ? (s - cum[i]) / segLen : 0;
    const x = poly[i].x + tt * (poly[i + 1].x - poly[i].x);
    const y = poly[i].y + tt * (poly[i + 1].y - poly[i].y);
    out[n] = { re: x, im: y };
  }
  return out;
}

/**
 * Discrete Fourier transform, centered on frequency 0.
 * c_f = (1/N) * Σ_n z_n * e^{-i2πfn/N}, for f = -floor(N/2) .. -floor(N/2)+N-1
 * (i.e. -N/2..N/2-1 when N is even).
 * @param {{re:number, im:number}[]} z
 * @returns {{freq:number, c:{re:number, im:number}}[]}
 */
export function dft(z) {
  const N = z.length;
  const fStart = -Math.floor(N / 2);

  const table = new Array(N);
  for (let k = 0; k < N; k++) {
    const theta = (-2 * Math.PI * k) / N;
    table[k] = { re: Math.cos(theta), im: Math.sin(theta) };
  }

  const out = new Array(N);
  for (let idx = 0; idx < N; idx++) {
    const f = fStart + idx;
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < N; n++) {
      let k = (f * n) % N;
      if (k < 0) k += N;
      const w = table[k];
      sumRe += z[n].re * w.re - z[n].im * w.im;
      sumIm += z[n].re * w.im + z[n].im * w.re;
    }
    out[idx] = { freq: f, c: { re: sumRe / N, im: sumIm / N } };
  }
  return out;
}

/**
 * Evaluate the inverse DFT series at time t (t in cycles, period 1):
 * z(t) = Σ_f c_f * e^{i2πft}
 * @param {{freq:number, c:{re:number, im:number}}[]} coeffs
 * @param {number} t
 * @returns {{re:number, im:number}}
 */
export function idftEval(coeffs, t) {
  let sumRe = 0;
  let sumIm = 0;
  for (const { freq, c } of coeffs) {
    const theta = 2 * Math.PI * freq * t;
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    sumRe += c.re * cs - c.im * sn;
    sumIm += c.re * sn + c.im * cs;
  }
  return { re: sumRe, im: sumIm };
}

/**
 * Keep the K largest-magnitude coefficients. The DC term (freq === 0), if
 * present, is always kept first regardless of its magnitude; the remaining
 * coefficients are sorted by |c| descending.
 * @param {{freq:number, c:{re:number, im:number}}[]} coeffs
 * @param {number} K
 * @returns {{freq:number, c:{re:number, im:number}}[]}
 */
export function topK(coeffs, K) {
  const dc = coeffs.filter((entry) => entry.freq === 0);
  const rest = coeffs
    .filter((entry) => entry.freq !== 0)
    .slice()
    .sort((a, b) => Math.hypot(b.c.re, b.c.im) - Math.hypot(a.c.re, a.c.im));
  return [...dc, ...rest].slice(0, K);
}

/**
 * Sample the epicycle path z(t) = Σ amp_k e^{i(2π f_k t + φ_k)} at M evenly
 * spaced times over one period, t = m/M for m = 0..M-1.
 * @param {{freq:number, amp:number, phase:number}[]} components
 * @param {number} [M=1000]
 * @returns {Float32Array} length 2M, laid out as [x0,y0,x1,y1,...]
 */
export function sampleSeries(components, M = 1000) {
  const out = new Float32Array(2 * M);
  for (let m = 0; m < M; m++) {
    const t = m / M;
    let sumRe = 0;
    let sumIm = 0;
    for (const comp of components) {
      const theta = 2 * Math.PI * comp.freq * t + comp.phase;
      sumRe += comp.amp * Math.cos(theta);
      sumIm += comp.amp * Math.sin(theta);
    }
    out[2 * m] = sumRe;
    out[2 * m + 1] = sumIm;
  }
  return out;
}

/**
 * First-order low-pass filter applied to each coefficient independently:
 * c_f' = c_f * H(f), H(f) = 1 / (1 + i f/fc).
 * @param {{freq:number, c:{re:number, im:number}}[]} coeffs
 * @param {number} fc - cutoff frequency
 * @returns {{freq:number, c:{re:number, im:number}}[]}
 */
export function lowpass(coeffs, fc) {
  return coeffs.map(({ freq, c }) => {
    const denomRe = 1;
    const denomIm = freq / fc;
    const denomSq = denomRe * denomRe + denomIm * denomIm;
    const hRe = denomRe / denomSq;
    const hIm = -denomIm / denomSq;
    return {
      freq,
      c: { re: c.re * hRe - c.im * hIm, im: c.re * hIm + c.im * hRe },
    };
  });
}

/**
 * Convert an amp/phase component to its complex Fourier coefficient:
 * c = amp * e^{iφ}.
 * @param {{amp:number, phase:number}} component
 * @returns {{re:number, im:number}}
 */
export function toCoeff(component) {
  return { re: component.amp * Math.cos(component.phase), im: component.amp * Math.sin(component.phase) };
}

/**
 * Convert a {freq, c} coefficient back into an amp/phase component,
 * merging in any extra fields (e.g. id, color).
 * @param {{freq:number, c:{re:number, im:number}}} coeff
 * @param {object} [extra={}]
 * @returns {{freq:number, amp:number, phase:number}}
 */
export function fromCoeff({ freq, c }, extra = {}) {
  return { freq, amp: Math.hypot(c.re, c.im), phase: Math.atan2(c.im, c.re), ...extra };
}
