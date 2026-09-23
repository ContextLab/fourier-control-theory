/**
 * Gesture kinematics: joint-angle Fourier series -> forward kinematics for an
 * articulated human arm + hand TREE (3 main joints: shoulder/upper-arm, elbow,
 * wrist/palm; then 5 fingers x 3 joints each = 15 finger joints, attached at
 * the palm's knuckle line). Each joint's RELATIVE angle is a short Fourier
 * series:
 *
 *   q_j(t) = q̄_j + Σ_{h=1..H} a_{j,h} cos(2π h t + ψ_{j,h}),  H ≤ 4
 *
 * and forward kinematics accumulates these along the tree exactly like the
 * spin-mode chain in core/arm.js: absolute angle θ_j = θ_parent(j) + q_j(t),
 * p_j = p_parent(j) + L_j e^{iθ_j} (plus a fixed lateral/forward attachment
 * offset for the 5 finger bases, which is anatomy, not state).
 *
 * Relation to spin mode (core/arm.js): spin mode is the special case where
 * every q_j(t) is UNBOUNDED and linear in t (q_j(t) = φ_j + 2π f_j t) rather
 * than a periodic sum of a few harmonics — that is what makes every joint
 * spin full circles and rules out human gestures. Gesture mode keeps q_j(t)
 * periodic (q_j(t) = q_j(t+1) for every j), which is what makes a "wave
 * hello" or "pick up a ball" motion possible: forward kinematics maps this
 * periodic JOINT-space signal into a task-space tip path that is generally
 * NOT itself a low-order Fourier series (FK is nonlinear), which is also why
 * the tip path's own spectrum (see spectrumView's "ghost" bars) differs from
 * the joint spectra shown here.
 * @module core/gesture
 */

const DEG = Math.PI / 180;

/** Build a `{mean, harmonics}` series literal. */
function s(mean, harmonics = []) {
  return { mean, harmonics };
}

/**
 * Evaluate a joint's relative angle at time t (radians):
 * q(t) = mean + Σ a_h cos(2π h t + ψ_h).
 * @param {{mean:number, harmonics:Array<{h:number,amp:number,phase:number}>}} series
 * @param {number} t
 * @returns {number}
 */
export function evalSeries(series, t) {
  let v = (series && series.mean) || 0;
  const harmonics = (series && series.harmonics) || [];
  for (const h of harmonics) {
    v += h.amp * Math.cos(2 * Math.PI * h.h * t + h.phase);
  }
  return v;
}

function dirOf(a) {
  return { re: Math.cos(a), im: Math.sin(a) };
}
function perpOf(a) {
  return { re: -Math.sin(a), im: Math.cos(a) };
}

/**
 * Forward kinematics for a bone tree at time t. Bones must be listed with
 * every parent appearing before its children. A bone with `parent: null`
 * attaches to the (optional) virtual `root` transform instead of the tree
 * origin — this lets a finger-only sub-tree be re-anchored onto an
 * externally-computed palm position/orientation (used to overlay an
 * articulated hand on the spin-mode chain).
 * @param {Array<{id:string, parent:?string, length:number,
 *   lateralOffset?:number, forwardOffset?:number,
 *   series:{mean:number, harmonics:Array}}>} bones
 * @param {number} t
 * @param {{root?: {absAngle:number, tip:{re:number,im:number}}}} [opts]
 * @returns {Map<string, {base:{re,im}, tip:{re,im}, absAngle:number, relAngle:number}>}
 */
export function forwardKinematics(bones, t, opts = {}) {
  const root = opts.root || { absAngle: 0, tip: { re: 0, im: 0 } };
  const out = new Map();
  for (const bone of bones) {
    const parent = bone.parent != null ? out.get(bone.parent) : null;
    const parentAbs = parent ? parent.absAngle : root.absAngle;
    const parentTip = parent ? parent.tip : root.tip;
    const d = dirOf(parentAbs);
    const p = perpOf(parentAbs);
    const fwd = bone.forwardOffset || 0;
    const lat = bone.lateralOffset || 0;
    const base = {
      re: parentTip.re + fwd * d.re + lat * p.re,
      im: parentTip.im + fwd * d.im + lat * p.im,
    };
    const rel = evalSeries(bone.series, t);
    const absAngle = parentAbs + rel;
    const tip = { re: base.re + bone.length * Math.cos(absAngle), im: base.im + bone.length * Math.sin(absAngle) };
    out.set(bone.id, { base, tip, absAngle, relAngle: rel });
  }
  return out;
}

/**
 * Sample one bone's tip position over one period (t = 0..1), for the
 * spectrum view's "tip path" ghost bars or for e2e assertions.
 * @param {Array<object>} bones
 * @param {string} boneId
 * @param {number} [M=1000]
 * @param {object} [opts]
 * @returns {Float32Array} length 2M, [x0,y0,x1,y1,...]
 */
export function sampleTipPath(bones, boneId, M = 1000, opts) {
  const out = new Float32Array(2 * M);
  for (let m = 0; m < M; m++) {
    const t = m / M;
    const fk = forwardKinematics(bones, t, opts);
    const p = fk.get(boneId).tip;
    out[2 * m] = p.re;
    out[2 * m + 1] = p.im;
  }
  return out;
}

/**
 * Flat per-joint metadata + series, for the editor and spectrum views.
 * @param {Array<object>} bones
 * @returns {Array<{id, label, group, color, series}>}
 */
export function jointAngleSeries(bones) {
  return bones.map((b) => ({
    id: b.id, label: b.label, group: b.group, color: b.color, series: b.series,
  }));
}

// -- Bone-tree structure (anatomy: lengths + attachment points; fixed) -----

const GROUP_COLORS = {
  arm: '#267aba',
  thumb: '#ffa00f',
  index: '#a5d75f',
  middle: '#8a6996',
  ring: '#d94415',
  little: '#9d162e',
};

/**
 * [proximal, middle, distal] lengths + palm attachment (lateral = along the
 * knuckle line, forward = along the palm's own direction), world units.
 * Lateral spacing is kept generously wide (relative to the finger widths in
 * ui/armSkin.js) so the 5 fingers always render as visibly SEPARATE
 * articulated chains — each its own outline, gaps between them — never as a
 * fused mitten silhouette.
 */
// `forward` is deliberately small: the palm bone's own tip already IS the
// knuckle line, so a finger's base should sit almost exactly there (a big
// forward offset would visually detach the hand from the palm, leaving a
// gap that reads as the fingers "floating" instead of growing out of it).
const FINGER_SPEC = [
  { name: 'thumb', group: 'thumb', lengths: [0.05, 0.038, 0.03], lateral: -0.095, forward: -0.03, spread: -55 * DEG },
  { name: 'index', group: 'index', lengths: [0.058, 0.036, 0.026], lateral: -0.06, forward: 0.01, spread: -8 * DEG },
  { name: 'middle', group: 'middle', lengths: [0.064, 0.042, 0.03], lateral: -0.02, forward: 0.015, spread: -1 * DEG },
  { name: 'ring', group: 'ring', lengths: [0.058, 0.038, 0.028], lateral: 0.02, forward: 0.008, spread: 5 * DEG },
  { name: 'little', group: 'little', lengths: [0.046, 0.03, 0.022], lateral: 0.065, forward: 0, spread: 12 * DEG },
];

/** Read-only finger anatomy table (lengths/attachment/spread per finger),
 * exported so armView.js can build the spin-mode "index-drives-the-hand"
 * overlay without duplicating these numbers. */
export const FINGER_GEOMETRY = FINGER_SPEC;

const JOINT_LABELS = { thumb: ['CMC', 'MCP', 'IP'] };
const DEFAULT_JOINT_LABELS = ['MCP', 'PIP', 'DIP'];

export const FINGER_NAMES = FINGER_SPEC.map((f) => f.name);
export const MAIN_JOINT_IDS = ['upperArm', 'forearm', 'palm'];
export const ALL_JOINT_IDS = [
  ...MAIN_JOINT_IDS,
  ...FINGER_NAMES.flatMap((n) => [`${n}1`, `${n}2`, `${n}3`]),
];

/**
 * Build the main 3-joint chain (shoulder/upper-arm -> elbow/forearm ->
 * wrist/palm).
 * @param {(id:string)=>{mean:number,harmonics:Array}} seriesFor
 */
export function buildMainChain(seriesFor) {
  return [
    { id: 'upperArm', parent: null, length: 0.34, group: 'arm', label: 'Upper arm', color: GROUP_COLORS.arm, series: seriesFor('upperArm') },
    { id: 'forearm', parent: 'upperArm', length: 0.29, group: 'arm', label: 'Forearm (elbow)', color: GROUP_COLORS.arm, series: seriesFor('forearm') },
    { id: 'palm', parent: 'forearm', length: 0.12, group: 'arm', label: 'Palm (wrist)', color: GROUP_COLORS.arm, series: seriesFor('palm') },
  ];
}

/**
 * Build the 15 finger-joint bones (5 fingers x 3 joints). Positive relative
 * angle beyond the "extended" pose (spread, 0, 0) curls the finger toward the
 * palm (flexion uses NEGATIVE relative angles by this module's convention).
 * @param {?string} parentId - 'palm' for a single full tree, or null to
 *   attach to the `root` option passed to forwardKinematics (used to overlay
 *   a hand onto an externally-computed palm transform, e.g. spin mode).
 * @param {(id:string, finger:object, jointIndex:number)=>{mean:number,harmonics:Array}} seriesFor
 */
export function buildFingerBones(parentId, seriesFor) {
  const bones = [];
  for (const f of FINGER_SPEC) {
    const labels = JOINT_LABELS[f.name] || DEFAULT_JOINT_LABELS;
    for (let j = 0; j < 3; j++) {
      const id = `${f.name}${j + 1}`;
      const parent = j === 0 ? parentId : `${f.name}${j}`;
      bones.push({
        id,
        parent,
        length: f.lengths[j],
        lateralOffset: j === 0 ? f.lateral : 0,
        forwardOffset: j === 0 ? f.forward : 0,
        group: f.group,
        label: `${f.name[0].toUpperCase()}${f.name.slice(1)} ${labels[j]}`,
        color: GROUP_COLORS[f.group],
        series: seriesFor(id, f, j),
      });
    }
  }
  return bones;
}

/**
 * Static, non-animated "relaxed curl" finger series (used to overlay a hand
 * onto the spin-mode chain, whose 5 components have no finger joints of
 * their own).
 */
export function relaxedHandSeries(id, finger, jointIndex) {
  const thumb = finger.name === 'thumb';
  if (jointIndex === 0) return s(finger.spread - (thumb ? 8 * DEG : 10 * DEG));
  if (jointIndex === 1) return s(-(thumb ? 10 * DEG : 28 * DEG));
  return s(-(thumb ? 8 * DEG : 20 * DEG));
}

// -- Presets -----------------------------------------------------------

/**
 * "Wave hello": upper arm raised and mostly static; the elbow oscillates
 * (h=1) to swing the forearm back and forth, the wrist follows with a phase
 * lag (h=1, phase shifted -90°) for a floppy-hand look, and fingers stay
 * extended with a small per-joint flutter (h=2).
 * @returns {Array<object>} the full 18-bone tree
 */
export function waveHelloBones() {
  const mainSeries = {
    upperArm: s(78 * DEG, [{ h: 1, amp: 3 * DEG, phase: 0 }]),
    forearm: s(78 * DEG, [{ h: 1, amp: 28 * DEG, phase: 0 }]),
    palm: s(-6 * DEG, [{ h: 1, amp: 35 * DEG, phase: -90 * DEG }]),
  };
  const main = buildMainChain((id) => mainSeries[id]);
  const fingers = buildFingerBones('palm', (id, finger, j) => {
    const flutter = { h: 2, amp: 4 * DEG, phase: j * 35 * DEG };
    if (j === 0) return s(finger.spread - 6 * DEG, [flutter]);
    if (j === 1) return s(-6 * DEG, [flutter]);
    return s(-5 * DEG, [flutter]);
  });
  return [...main, ...fingers];
}

/**
 * "Pick up a ball": the arm reaches down once per period (h=1 + h=2 shaping
 * the dwell at the bottom), the four main fingers close together (a shared
 * flex curve — the "symmetric pose" used by the grasp) while the thumb closes
 * oppositely to meet them, then the arm lifts, holds, lowers, and the fingers
 * release before the arm withdraws. See {@link pickupBallState} for how the
 * ball itself is derived from this purely as a function of t.
 * @returns {Array<object>} the full 18-bone tree
 */
export function pickupBallBones() {
  const mainSeries = {
    upperArm: s(-18 * DEG, [
      { h: 1, amp: 52 * DEG, phase: -90 * DEG },
      { h: 2, amp: 14 * DEG, phase: 90 * DEG },
    ]),
    forearm: s(70 * DEG, [
      { h: 1, amp: 25 * DEG, phase: 90 * DEG },
      { h: 2, amp: 10 * DEG, phase: -90 * DEG },
    ]),
    palm: s(-4 * DEG, [
      { h: 1, amp: 10 * DEG, phase: 90 * DEG },
    ]),
  };
  const main = buildMainChain((id) => mainSeries[id]);
  // Identical flex curve for ALL FIVE fingers (the "symmetric pose" the grasp
  // relies on — see the gesture.test.js "symmetric flex" check): extended
  // most of the period, closing (more negative relAngle) once near the
  // bottom of the reach, tuned so the peak coincides with the arm's lowest
  // point (t ~= 0.70, see pickupBallBones' upperArm/forearm phases above).
  const flexA = { h: 1, amp: 34 * DEG, phase: -72 * DEG };
  const flexB = { h: 2, amp: 22 * DEG, phase: 36 * DEG };
  const fingers = buildFingerBones('palm', (id, finger, j) => {
    if (j === 0) return s(finger.spread - 8 * DEG, [{ ...flexA, amp: flexA.amp * 0.7 }, { ...flexB, amp: flexB.amp * 0.7 }]);
    if (j === 1) return s(-8 * DEG, [flexA, flexB]);
    return s(-6 * DEG, [{ ...flexA, amp: flexA.amp * 0.85 }, { ...flexB, amp: flexB.amp * 0.85 }]);
  });
  return [...main, ...fingers];
}

/** Ids of the 4 main fingers' distal tips + thumb tip, used for the grasp centroid. */
const FINGERTIP_IDS = ['thumb3', 'index3', 'middle3', 'ring3', 'little3'];
const FLEX_JOINT_IDS = ['index2', 'middle2', 'ring2', 'little2'];

/** Ball + table geometry for the "pick up a ball" preset (world units), tuned
 * to where {@link pickupBallBones}'s fingertip centroid actually reaches. */
export const PICKUP = {
  tableY: -0.258,
  ballRestX: 0.487,
  ballRadius: 0.045,
  graspRadius: 0.11,
  flexThreshold: 30 * DEG,
};

/**
 * Derive the ball's position (and whether it is grasped) at time t, purely as
 * a function of t and the hand's own FK: the ball sits at its resting spot on
 * the table until the fingertip centroid comes within `graspRadius` of it
 * AND the fingers are flexed past `flexThreshold`, at which point it follows
 * the hand; otherwise it sits back on the table. Because both conditions are
 * recomputed from scratch at every t, this is automatically periodic and
 * naturally fails (the arm never reaches the ball) when the reach is
 * band-limited away in the Control tab.
 * @param {Array<object>} bones
 * @param {number} t
 * @param {object} [pickup=PICKUP]
 * @returns {{pos:{re:number,im:number}, attached:boolean, flex:number, dist:number}}
 */
export function pickupBallState(bones, t, pickup = PICKUP) {
  const fk = forwardKinematics(bones, t);
  let cx = 0;
  let cy = 0;
  for (const id of FINGERTIP_IDS) {
    const p = fk.get(id).tip;
    cx += p.re;
    cy += p.im;
  }
  cx /= FINGERTIP_IDS.length;
  cy /= FINGERTIP_IDS.length;
  let flex = 0;
  for (const id of FLEX_JOINT_IDS) flex += -fk.get(id).relAngle;
  flex /= FLEX_JOINT_IDS.length;
  const dist = Math.hypot(cx - pickup.ballRestX, cy - pickup.tableY);
  const attached = flex > pickup.flexThreshold && dist < pickup.graspRadius;
  const pos = attached
    ? { re: cx, im: cy }
    : { re: pickup.ballRestX, im: pickup.tableY };
  return { pos, attached, flex, dist };
}

/**
 * Apply the Control tab's actuator-bandwidth + lag filter to a single joint's
 * series: drop harmonics with h > B, and (when `useLag`) shrink/phase-lag the
 * survivors by H(h) = 1/(1 + i h/fc), matching fourier.lowpass's convention.
 * B=0 keeps only the mean, i.e. freezes that joint at its mean angle.
 * @param {{mean:number, harmonics:Array<{h:number,amp:number,phase:number}>}} series
 * @param {number} B
 * @param {boolean} useLag
 * @param {number} fc
 * @returns {{mean:number, harmonics:Array}}
 */
export function filterSeries(series, B, useLag, fc) {
  const harmonics = (series.harmonics || [])
    .filter((h) => h.h <= B)
    .map((h) => {
      if (!useLag) return { ...h };
      const denomIm = h.h / fc;
      const mag = 1 / Math.sqrt(1 + denomIm * denomIm);
      const argShift = -Math.atan2(denomIm, 1);
      return { h: h.h, amp: h.amp * mag, phase: h.phase + argShift };
    });
  return { mean: series.mean, harmonics };
}

/**
 * Apply {@link filterSeries} to every bone in a tree, returning a new bone
 * list (bones are shallow-cloned; anatomy fields are shared, only `series`
 * changes).
 * @param {Array<object>} bones
 * @param {number} B
 * @param {boolean} useLag
 * @param {number} fc
 * @returns {Array<object>}
 */
export function filterBones(bones, B, useLag, fc) {
  return bones.map((b) => ({ ...b, series: filterSeries(b.series, B, useLag, fc) }));
}
