/**
 * Central app state + pub/sub. No DOM access; importable under Node.
 * @module core/store
 */

import { sampleSeries, toCoeff } from './fourier.js';

export const PALETTE = ['#267aba', '#ffa00f', '#a5d75f', '#8a6996', '#d94415', '#f5dc69', '#c4dd88', '#9d162e'];

/** Largest (in magnitude) frequency a component may hold, in cycles/period. */
export const MAX_FREQ = 64;
/** Largest amplitude a component may hold. */
export const MAX_AMP = 5;

/** Wrap a phase (radians) into (−π, π]. */
function wrapPhase(phase) {
  let x = phase % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Clamp/repair a component's freq/amp/phase so every store entry point holds
 * safe, in-range values regardless of what a drag, editor field, or preset
 * hands in. Other fields (id, color, label, ...) pass through untouched.
 * - freq: rounded to the nearest integer, clamped to [−MAX_FREQ, MAX_FREQ] (NaN → 0;
 *   ±Infinity clamp to ±MAX_FREQ like any other too-large value)
 * - amp: clamped to [0, MAX_AMP] (NaN → 0; +Infinity clamps to MAX_AMP)
 * - phase: finite, wrapped to (−π, π] (NaN or ±Infinity → 0)
 * @param {object} c
 * @returns {object}
 */
export function sanitizeComponent(c) {
  let freq = Math.round(Number(c.freq));
  if (Number.isNaN(freq)) freq = 0;
  freq = clamp(freq, -MAX_FREQ, MAX_FREQ);

  let amp = Number(c.amp);
  if (Number.isNaN(amp)) amp = 0;
  amp = clamp(amp, 0, MAX_AMP);

  let phase = Number(c.phase);
  phase = Number.isFinite(phase) ? wrapPhase(phase) : 0;

  return { ...c, freq, amp, phase };
}

function defaultState() {
  return {
    components: [],
    t: 0,
    playing: false,
    speed: 1,
    mode: 'arm',
    selectedId: null,
    yScale: 'amp',
    showCircles: true,
    K: 50,
    bandwidth: 5,
    drawing: { raw: [], coeffs: [], active: false },
  };
}

/**
 * Create the app store.
 * @param {object} [initial={}] - partial state to merge over the defaults
 * @returns {{
 *   get: () => object,
 *   set: (patch: object, source?: string) => void,
 *   setTime: (t: number) => void,
 *   updateComponent: (id: number, patch: object, source?: string) => void,
 *   addComponent: (partial?: object) => number,
 *   removeComponent: (id: number, source?: string) => void,
 *   setComponents: (list: object[], source?: string) => void,
 *   subscribe: (fn: (state: object, changedKeys: Set<string>, source?: string) => void, keys?: string[]) => () => void,
 *   derived: () => { path: Float32Array, spectrum: Map<number, {sum:{re:number,im:number}, ids:number[]}> },
 * }}
 */
export function createStore(initial = {}) {
  let state = { ...defaultState(), ...initial };
  let nextId = 1 + state.components.reduce((m, c) => Math.max(m, c.id || 0), 0);

  // Give every component a unique id and a palette color. Components without an
  // id (e.g. straight from preset()) or with an id already used in the list get
  // a fresh one, so updateComponent/removeComponent always target exactly one.
  function withIds(list) {
    const seen = new Set();
    return list.map((c) => {
      let out = sanitizeComponent(c);
      if (out.id == null || seen.has(out.id)) {
        const id = nextId++;
        out = { ...out, id };
      } else if (out.id >= nextId) {
        nextId = out.id + 1;
      }
      if (!out.color) out = { ...out, color: PALETTE[(out.id - 1) % PALETTE.length] };
      seen.add(out.id);
      return out;
    });
  }
  state.components = withIds(state.components);
  let subscribers = [];
  let dirty = true;
  let cachedDerived = null;

  function notify(changedKeys, source) {
    for (const sub of subscribers) {
      if (!sub.keys || sub.keys.some((k) => changedKeys.has(k))) {
        sub.fn(state, changedKeys, source);
      }
    }
  }

  return {
    /** Current state (read-only by convention). */
    get() {
      return state;
    },

    /** Shallow-merge a patch into state and notify subscribers. */
    set(patch, source) {
      const changedKeys = new Set(Object.keys(patch));
      if (patch.components) patch = { ...patch, components: withIds(patch.components) };
      state = { ...state, ...patch };
      if (changedKeys.has('components')) dirty = true;
      notify(changedKeys, source);
    },

    /** Update the current time. Does NOT notify (the rAF loop renders every frame). */
    setTime(t) {
      state = { ...state, t };
    },

    /** Patch a single component by id. */
    updateComponent(id, patch, source) {
      state = {
        ...state,
        components: state.components.map((c) => (c.id === id ? sanitizeComponent({ ...c, ...patch }) : c)),
      };
      dirty = true;
      notify(new Set(['components']), source);
    },

    /** Add a component, assigning the next id and palette color. Returns the new id. */
    addComponent(partial = {}) {
      const id = nextId++;
      const color = PALETTE[(id - 1) % PALETTE.length];
      const comp = sanitizeComponent({ freq: 0, amp: 0.2, phase: 0, color, ...partial, id });
      state = { ...state, components: [...state.components, comp] };
      dirty = true;
      notify(new Set(['components']), 'store');
      return id;
    },

    /** Remove a component by id. */
    removeComponent(id, source) {
      state = { ...state, components: state.components.filter((c) => c.id !== id) };
      dirty = true;
      notify(new Set(['components']), source);
    },

    /** Replace the whole components list. */
    setComponents(list, source) {
      state = { ...state, components: withIds(list) };
      dirty = true;
      notify(new Set(['components']), source);
    },

    /** Subscribe to state changes, optionally filtered to a set of keys. Returns an unsubscribe function. */
    subscribe(fn, keys) {
      const sub = { fn, keys: keys || null };
      subscribers.push(sub);
      return () => {
        subscribers = subscribers.filter((s) => s !== sub);
      };
    },

    /** Lazily-recomputed derived data (path samples + grouped spectrum), cached until components change. */
    derived() {
      if (dirty || !cachedDerived) {
        const path = sampleSeries(state.components, 1000);
        const spectrum = new Map();
        for (const c of state.components) {
          const coeff = toCoeff(c);
          if (!spectrum.has(c.freq)) spectrum.set(c.freq, { sum: { re: 0, im: 0 }, ids: [] });
          const entry = spectrum.get(c.freq);
          entry.sum = { re: entry.sum.re + coeff.re, im: entry.sum.im + coeff.im };
          entry.ids.push(c.id);
        }
        cachedDerived = { path, spectrum };
        dirty = false;
      }
      return cachedDerived;
    },
  };
}
