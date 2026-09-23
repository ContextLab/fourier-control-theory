import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, sanitizeComponent, MAX_FREQ, MAX_AMP, PALETTE } from '../../js/core/store.js';

test('createStore starts with the documented default shape', () => {
  const store = createStore();
  const s = store.get();
  assert.deepEqual(s.components, []);
  assert.equal(s.t, 0);
  assert.equal(s.playing, false);
  assert.equal(s.speed, 1);
  assert.equal(s.mode, 'arm');
  assert.equal(s.selectedId, null);
  assert.equal(s.yScale, 'amp');
  assert.equal(s.showCircles, true);
  assert.equal(s.K, 50);
  assert.equal(s.bandwidth, 5);
  assert.deepEqual(s.drawing, { raw: [], coeffs: [], active: false });
});

test('addComponent assigns increasing ids and cycles the palette', () => {
  const store = createStore();
  const id1 = store.addComponent({ freq: 1, amp: 1, phase: 0 });
  const id2 = store.addComponent({ freq: 2, amp: 0.5, phase: 0 });
  assert.notEqual(id1, id2);
  const comps = store.get().components;
  assert.equal(comps.length, 2);
  assert.ok(comps[0].color);
  assert.ok(comps[1].color);
});

test('setTime updates t but does NOT notify subscribers', () => {
  const store = createStore();
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.setTime(0.5);
  assert.equal(store.get().t, 0.5);
  assert.equal(calls, 0);
});

test('subscribe with no keys filter fires on any set()', () => {
  const store = createStore();
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  store.set({ playing: true });
  assert.equal(calls, 1);
});

test('subscribe with a keys filter only fires when a matching key changes', () => {
  const store = createStore();
  let speedCalls = 0;
  let componentCalls = 0;
  store.subscribe(() => {
    speedCalls += 1;
  }, ['speed']);
  store.subscribe(() => {
    componentCalls += 1;
  }, ['components']);

  store.set({ speed: 2 });
  assert.equal(speedCalls, 1);
  assert.equal(componentCalls, 0);

  store.addComponent({ freq: 1, amp: 1, phase: 0 });
  assert.equal(speedCalls, 1);
  assert.equal(componentCalls, 1);
});

test('subscribe passes (state, changedKeys, source) and unsubscribe stops delivery', () => {
  const store = createStore();
  const seen = [];
  const unsub = store.subscribe((state, changedKeys, source) => {
    seen.push({ mode: state.mode, keys: [...changedKeys], source });
  });
  store.set({ mode: 'draw' }, 'ui:tab');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, 'draw');
  assert.deepEqual(seen[0].keys, ['mode']);
  assert.equal(seen[0].source, 'ui:tab');

  unsub();
  store.set({ mode: 'control' }, 'ui:tab');
  assert.equal(seen.length, 1);
});

test('derived() is lazily cached and only recomputed when components change', () => {
  const store = createStore();
  store.addComponent({ freq: 1, amp: 1, phase: 0 });

  const first = store.derived();
  const second = store.derived();
  assert.equal(first, second, 'derived() should return the same cached object when components are unchanged');

  store.set({ t: 0.9 }); // unrelated change
  const third = store.derived();
  assert.equal(second, third, 'a non-component change must not invalidate the derived cache');

  store.addComponent({ freq: 2, amp: 0.3, phase: 0 });
  const fourth = store.derived();
  assert.notEqual(third, fourth, 'adding a component must invalidate the derived cache');
});

test('derived().path has the expected sample length and spectrum groups by frequency', () => {
  const store = createStore();
  const id1 = store.addComponent({ freq: 1, amp: 1, phase: 0 });
  const id2 = store.addComponent({ freq: 1, amp: 0.5, phase: Math.PI });
  const d = store.derived();
  assert.equal(d.path.length, 2000); // default M=1000 -> 2M floats
  assert.ok(d.spectrum instanceof Map);
  const group = d.spectrum.get(1);
  assert.ok(group);
  assert.deepEqual(group.ids.sort(), [id1, id2].sort());
  // amp 1 @ phase 0 plus amp 0.5 @ phase pi cancel by 0.5 along the real axis
  assert.ok(Math.abs(group.sum.re - 0.5) < 1e-9);
  assert.ok(Math.abs(group.sum.im) < 1e-9);
});

test('removeComponent removes it from state and invalidates the derived cache', () => {
  const store = createStore();
  const id1 = store.addComponent({ freq: 1, amp: 1, phase: 0 });
  const id2 = store.addComponent({ freq: 2, amp: 0.5, phase: 0 });
  const before = store.derived();

  store.removeComponent(id1);
  assert.equal(store.get().components.length, 1);
  assert.equal(store.get().components[0].id, id2);

  const after = store.derived();
  assert.notEqual(before, after);
  assert.equal(after.spectrum.has(1), false);
});

test('updateComponent patches a single component by id and invalidates derived', () => {
  const store = createStore();
  const id = store.addComponent({ freq: 1, amp: 1, phase: 0 });
  const before = store.derived();
  store.updateComponent(id, { amp: 0.25 });
  assert.equal(store.get().components[0].amp, 0.25);
  const after = store.derived();
  assert.notEqual(before, after);
});

test('setComponents replaces the whole list', () => {
  const store = createStore();
  store.addComponent({ freq: 1, amp: 1, phase: 0 });
  const list = [
    { id: 99, freq: 5, amp: 0.4, phase: 0, color: '#fff' },
  ];
  store.setComponents(list, 'preset');
  assert.deepEqual(store.get().components, list);
});

test('setComponents and addComponent preserve an unknown extra field like "label"', () => {
  const store = createStore();
  store.setComponents([{ id: 42, freq: 1, amp: 1, phase: 0, color: '#fff', label: 'Upper arm' }], 'preset');
  assert.equal(store.get().components[0].label, 'Upper arm');

  const id = store.addComponent({ freq: 2, amp: 0.5, phase: 0, label: 'Forearm' });
  const added = store.get().components.find((c) => c.id === id);
  assert.equal(added.label, 'Forearm');

  store.updateComponent(id, { amp: 0.25 });
  const patched = store.get().components.find((c) => c.id === id);
  assert.equal(patched.label, 'Forearm');
});

test('id-less components (initial, setComponents, set) get unique ids and colors', () => {
  const store = createStore({ components: [{ freq: 1, amp: 0.5, phase: 0 }, { freq: 2, amp: 0.5, phase: 0 }] });
  let ids = store.get().components.map((c) => c.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => Number.isInteger(id)));
  assert.ok(store.get().components.every((c) => typeof c.color === 'string'));

  store.setComponents([{ freq: 1, amp: 0.3, phase: 0 }, { freq: 3, amp: 0.3, phase: 0 }, { freq: 5, amp: 0.3, phase: 0 }]);
  ids = store.get().components.map((c) => c.id);
  assert.equal(new Set(ids).size, 3);

  // Removing one must remove exactly one.
  store.removeComponent(ids[1]);
  assert.deepEqual(store.get().components.map((c) => c.freq), [1, 5]);

  store.set({ components: [{ freq: 7, amp: 1, phase: 0 }] });
  assert.ok(Number.isInteger(store.get().components[0].id));

  // A later addComponent never collides with an existing id.
  const newId = store.addComponent({ freq: 2 });
  const all = store.get().components.map((c) => c.id);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.includes(newId));
});

test('duplicate ids in a supplied list are de-duplicated', () => {
  const store = createStore();
  store.setComponents([{ id: 4, freq: 1, amp: 1, phase: 0 }, { id: 4, freq: 2, amp: 1, phase: 0 }]);
  const ids = store.get().components.map((c) => c.id);
  assert.equal(ids[0], 4);
  assert.notEqual(ids[1], 4);
});

test('MAX_FREQ and MAX_AMP and PALETTE are exported', () => {
  assert.equal(MAX_FREQ, 256);
  assert.equal(MAX_AMP, 5);
  assert.ok(Array.isArray(PALETTE));
  assert.ok(PALETTE.length > 0);
});

test('sanitizeComponent rounds freq and clamps it to [-MAX_FREQ, MAX_FREQ]', () => {
  assert.equal(sanitizeComponent({ freq: 2.6, amp: 0, phase: 0 }).freq, 3);
  assert.equal(sanitizeComponent({ freq: -0.6, amp: 0, phase: 0 }).freq, -1);
  assert.equal(sanitizeComponent({ freq: 1e6, amp: 0, phase: 0 }).freq, MAX_FREQ);
  assert.equal(sanitizeComponent({ freq: -1e6, amp: 0, phase: 0 }).freq, -MAX_FREQ);
  assert.equal(sanitizeComponent({ freq: Infinity, amp: 0, phase: 0 }).freq, MAX_FREQ);
  assert.equal(sanitizeComponent({ freq: -Infinity, amp: 0, phase: 0 }).freq, -MAX_FREQ);
  assert.equal(sanitizeComponent({ freq: NaN, amp: 0, phase: 0 }).freq, 0);
});

test('sanitizeComponent rounds freq symmetrically (sign(x)*Math.round(|x|)), not JS round-half-up', () => {
  // JS's own Math.round(-2.5) is -2 (ties round toward +Infinity); the store must
  // round the magnitude and reapply the sign so -2.5 mirrors 2.5 exactly.
  assert.equal(sanitizeComponent({ freq: 2.5, amp: 0, phase: 0 }).freq, 3);
  assert.equal(sanitizeComponent({ freq: -2.5, amp: 0, phase: 0 }).freq, -3);
  assert.equal(sanitizeComponent({ freq: -0.5, amp: 0, phase: 0 }).freq, -1);
});

test('sanitizeComponent clamps amp to [0, MAX_AMP] and maps NaN to 0', () => {
  assert.equal(sanitizeComponent({ freq: 0, amp: 370, phase: 0 }).amp, MAX_AMP);
  assert.equal(sanitizeComponent({ freq: 0, amp: NaN, phase: 0 }).amp, 0);
  assert.equal(sanitizeComponent({ freq: 0, amp: Infinity, phase: 0 }).amp, MAX_AMP);
  assert.equal(sanitizeComponent({ freq: 0, amp: 2, phase: 0 }).amp, 2);
});

test('sanitizeComponent folds a negative amp to |amp| with the phase shifted by pi', () => {
  // -|c|e^{i phi} === |c|e^{i(phi+pi)}: a negative amplitude is the same point
  // on the circle as its absolute value with phase rotated by pi.
  const a = sanitizeComponent({ freq: 0, amp: -0.5, phase: 0 });
  assert.equal(a.amp, 0.5);
  assert.ok(Math.abs(a.phase - Math.PI) < 1e-9);

  const b = sanitizeComponent({ freq: 0, amp: -2, phase: Math.PI / 2 });
  assert.equal(b.amp, 2);
  assert.ok(Math.abs(b.phase - (-Math.PI / 2)) < 1e-9); // pi/2 + pi wraps to -pi/2

  // A negative amp that overflows MAX_AMP after taking the absolute value still clamps.
  const c = sanitizeComponent({ freq: 0, amp: -370, phase: 0 });
  assert.equal(c.amp, MAX_AMP);

  // -Infinity flips to +Infinity, then clamps to MAX_AMP.
  const d = sanitizeComponent({ freq: 0, amp: -Infinity, phase: 0 });
  assert.equal(d.amp, MAX_AMP);
  assert.ok(Math.abs(d.phase - Math.PI) < 1e-9);
});

test('sanitizeComponent wraps phase to (-pi, pi] and maps NaN to 0', () => {
  close(sanitizeComponent({ freq: 0, amp: 0, phase: Math.PI }).phase, Math.PI);
  close(sanitizeComponent({ freq: 0, amp: 0, phase: -Math.PI }).phase, Math.PI);
  close(sanitizeComponent({ freq: 0, amp: 0, phase: 4 * Math.PI }).phase, 0); // 720 deg
  close(sanitizeComponent({ freq: 0, amp: 0, phase: 3 * Math.PI }).phase, Math.PI);
  assert.equal(sanitizeComponent({ freq: 0, amp: 0, phase: NaN }).phase, 0);
  assert.equal(sanitizeComponent({ freq: 0, amp: 0, phase: Infinity }).phase, 0);
  assert.equal(sanitizeComponent({ freq: 0, amp: 0, phase: -Infinity }).phase, 0);

  function close(a, b, eps = 1e-9) {
    assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
  }
});

test('sanitizeComponent preserves non-numeric fields like id, color, label', () => {
  const c = sanitizeComponent({ id: 7, freq: 1, amp: 1, phase: 0, color: '#abc', label: 'Upper arm' });
  assert.equal(c.id, 7);
  assert.equal(c.color, '#abc');
  assert.equal(c.label, 'Upper arm');
});

test('addComponent, updateComponent, setComponents, and set({components}) all sanitize', () => {
  const store = createStore();

  const id = store.addComponent({ freq: 2.6, amp: 370, phase: 4 * Math.PI });
  const added = store.get().components.find((c) => c.id === id);
  assert.equal(added.freq, 3);
  assert.equal(added.amp, MAX_AMP);
  assert.ok(Math.abs(added.phase) < 1e-9);

  store.updateComponent(id, { amp: -5, freq: 1e6 });
  const updated = store.get().components.find((c) => c.id === id);
  assert.equal(updated.amp, MAX_AMP); // |-5| clamps to MAX_AMP (5)
  assert.ok(Math.abs(updated.phase - Math.PI) < 1e-9); // 0 (from the add above) + pi
  assert.equal(updated.freq, MAX_FREQ);

  store.setComponents([{ freq: -1e6, amp: NaN, phase: NaN }]);
  assert.equal(store.get().components[0].freq, -MAX_FREQ);
  assert.equal(store.get().components[0].amp, 0);
  assert.equal(store.get().components[0].phase, 0);

  store.set({ components: [{ freq: MAX_FREQ + 50, amp: 8, phase: 0 }] });
  assert.equal(store.get().components[0].freq, MAX_FREQ);
  assert.equal(store.get().components[0].amp, MAX_AMP);
});
