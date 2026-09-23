/**
 * Pure complex-number helpers. A complex number is represented as a plain
 * object `{re, im}` (never a class instance) so it can be freely cloned,
 * serialized, and compared with `deepStrictEqual` in tests.
 * @module core/complex
 */

/**
 * Euler's formula: e^{iθ} = cos θ + i sin θ.
 * @param {number} theta - angle in radians
 * @returns {{re:number, im:number}}
 */
export function expi(theta) {
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

/**
 * Complex addition a + b.
 * @param {{re:number, im:number}} a
 * @param {{re:number, im:number}} b
 * @returns {{re:number, im:number}}
 */
export function add(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}

/**
 * Complex subtraction a - b.
 * @param {{re:number, im:number}} a
 * @param {{re:number, im:number}} b
 * @returns {{re:number, im:number}}
 */
export function sub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}

/**
 * Complex multiplication a * b.
 * @param {{re:number, im:number}} a
 * @param {{re:number, im:number}} b
 * @returns {{re:number, im:number}}
 */
export function mul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

/**
 * Scale a complex number by a real scalar.
 * @param {{re:number, im:number}} z
 * @param {number} s
 * @returns {{re:number, im:number}}
 */
export function scale(z, s) {
  return { re: z.re * s, im: z.im * s };
}

/**
 * Magnitude |z|.
 * @param {{re:number, im:number}} z
 * @returns {number}
 */
export function abs(z) {
  return Math.hypot(z.re, z.im);
}

/**
 * Argument (angle) of z, in radians, via atan2.
 * @param {{re:number, im:number}} z
 * @returns {number}
 */
export function arg(z) {
  return Math.atan2(z.im, z.re);
}

/**
 * Build a complex number from polar coordinates: r * e^{iφ}.
 * @param {number} r - radius/amplitude
 * @param {number} phi - angle in radians
 * @returns {{re:number, im:number}}
 */
export function fromPolar(r, phi) {
  return { re: r * Math.cos(phi), im: r * Math.sin(phi) };
}
