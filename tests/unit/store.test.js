import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../js/core/store.js';

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
