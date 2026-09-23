import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preset, PRESET_NAMES } from '../../js/core/presets.js';

function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b} (eps ${eps})`);
}

test('PRESET_NAMES lists every name preset() accepts, with "arm" first', () => {
  assert.deepEqual(PRESET_NAMES, ['arm', 'circle', 'ellipse', 'square', 'sawtooth', 'star', 'heart']);
});

for (const name of PRESET_NAMES) {
  test(`preset('${name}') returns a non-empty, normalized (sum amp ~= 1) component list`, () => {
    const components = preset(name);
    assert.ok(Array.isArray(components));
    assert.ok(components.length > 0);
    let sum = 0;
    for (const c of components) {
      assert.equal(typeof c.freq, 'number');
      assert.ok(Number.isInteger(c.freq));
      assert.ok(c.amp >= 0);
      assert.equal(typeof c.phase, 'number');
      sum += c.amp;
    }
    close(sum, 1, 1e-3);
  });
}

test("preset('arm') returns 5 labeled human-arm bones summing to unit amplitude", () => {
  const components = preset('arm');
  assert.equal(components.length, 5);
  const expectedLabels = ['Upper arm', 'Forearm', 'Hand', 'Finger', 'Fingertip'];
  assert.deepEqual(
    components.map((c) => c.label),
    expectedLabels
  );
  let sum = 0;
  for (const c of components) sum += c.amp;
  close(sum, 1, 1e-9);
});

test('preset throws on an unknown name', () => {
  assert.throws(() => preset('not-a-real-preset'));
});

test("preset('circle') is a single unit component at frequency 1", () => {
  const components = preset('circle');
  assert.equal(components.length, 1);
  close(components[0].freq, 1);
  close(components[0].amp, 1);
});

test('preset(name, n) respects the component-count cap for shape-derived presets', () => {
  const many = preset('star', 40);
  const few = preset('star', 3);
  assert.ok(many.length <= 40);
  assert.equal(few.length, 3);
});

for (const name of ['square', 'sawtooth', 'star']) {
  test(`preset('${name}', n) drops the near-zero DC term instead of wasting a slot on it`, () => {
    const n = 5;
    const components = preset(name, n);
    // All n requested slots should go to real (non-DC) links, not a wasted
    // zero-amplitude freq=0 term.
    assert.equal(components.length, n);
    for (const c of components) {
      assert.notEqual(c.freq, 0);
    }
  });
}
