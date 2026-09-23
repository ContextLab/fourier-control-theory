import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expi, add, sub, mul, scale, abs, arg, fromPolar } from '../../js/core/complex.js';

function close(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
}

test('expi produces a unit complex number at the given angle', () => {
  const z = expi(Math.PI / 2);
  close(z.re, 0);
  close(z.im, 1);
});

test('add / sub are inverses', () => {
  const a = { re: 1, im: 2 };
  const b = { re: 3, im: -4 };
  const sum = add(a, b);
  assert.deepEqual(sum, { re: 4, im: -2 });
  const back = sub(sum, b);
  close(back.re, a.re);
  close(back.im, a.im);
});

test('mul matches (a+bi)(c+di) = (ac-bd)+(ad+bc)i', () => {
  const a = { re: 2, im: 3 };
  const b = { re: 5, im: -1 };
  const p = mul(a, b);
  close(p.re, 2 * 5 - 3 * -1);
  close(p.im, 2 * -1 + 3 * 5);
});

test('mul by i rotates 90 degrees', () => {
  const i = { re: 0, im: 1 };
  const p = mul({ re: 1, im: 0 }, i);
  close(p.re, 0);
  close(p.im, 1);
});

test('scale multiplies both components by the scalar', () => {
  const z = scale({ re: 2, im: -3 }, 4);
  close(z.re, 8);
  close(z.im, -12);
});

test('abs returns the Euclidean magnitude', () => {
  close(abs({ re: 3, im: 4 }), 5);
});

test('arg returns atan2(im, re)', () => {
  close(arg({ re: 0, im: 1 }), Math.PI / 2);
  close(arg({ re: -1, im: 0 }), Math.PI);
});

test('fromPolar / abs / arg round-trip', () => {
  const r = 2.5;
  const phi = 1.1;
  const z = fromPolar(r, phi);
  close(abs(z), r);
  close(arg(z), phi);
});
