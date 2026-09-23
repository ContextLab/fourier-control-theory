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

function clampUnit(x) {
  return Math.max(0, Math.min(1, x));
}
function smoothstep01(x) {
  const c = clampUnit(x);
  return c * c * (3 - 2 * c);
}

/**
 * Build a periodic function from explicit (time, value) keyframes, smoothly
 * eased (smoothstep) between consecutive keyframes and wrapping from the
 * last keyframe back to the first at t=1. Used to author a multi-phase
 * gesture (reach, grasp, lift, hold, lower, release, withdraw) directly as a
 * pose sequence, which {@link fitHarmonics} then approximates with a
 * bounded-H Fourier series.
 * @param {Array<[number, number]>} keyframes - [t in [0,1), value] pairs, any order
 * @returns {(t:number)=>number}
 */
function keyframeFn(keyframes) {
  const kfs = keyframes.slice().sort((a, b) => a[0] - b[0]);
  const n = kfs.length;
  return (t) => {
    const tt = ((t % 1) + 1) % 1;
    for (let i = 0; i < n; i += 1) {
      const [t0, v0] = kfs[i];
      const isLast = i === n - 1;
      const t1 = isLast ? kfs[0][0] + 1 : kfs[i + 1][0];
      const v1 = isLast ? kfs[0][1] : kfs[i + 1][1];
      if (tt >= t0 && (tt < t1 || isLast)) {
        const span = t1 - t0;
        const u = span > 1e-9 ? (tt - t0) / span : 0;
        return v0 + (v1 - v0) * smoothstep01(u);
      }
    }
    return kfs[0][1];
  };
}

/**
 * Least-squares (exact, via numerical integration) real Fourier fit of a
 * periodic function to H harmonics: the best possible q̄ + Σ a_h cos(2πht+ψ_h)
 * approximation with only H harmonics, which is how the keyframed gesture
 * presets stay within this module's H≤4 joint-angle-series model while still
 * hitting explicit target poses (reach, grasp, lift, ...) at chosen times.
 * @param {(t:number)=>number} fn - periodic (period 1), value in radians
 * @param {number} [H=4]
 * @param {number} [N=512] - sample count for the numerical integration
 * @returns {{mean:number, harmonics:Array<{h:number,amp:number,phase:number}>}}
 */
function fitHarmonics(fn, H = 4, N = 512) {
  let mean = 0;
  const A = new Array(H + 1).fill(0);
  const B = new Array(H + 1).fill(0);
  for (let n = 0; n < N; n += 1) {
    const t = n / N;
    const v = fn(t);
    mean += v;
    for (let h = 1; h <= H; h += 1) {
      const theta = 2 * Math.PI * h * t;
      A[h] += v * Math.cos(theta);
      B[h] += v * Math.sin(theta);
    }
  }
  mean /= N;
  const harmonics = [];
  for (let h = 1; h <= H; h += 1) {
    const Ah = (2 * A[h]) / N;
    const Bh = (2 * B[h]) / N;
    const amp = Math.hypot(Ah, Bh);
    if (amp < 1e-7) continue;
    const phase = Math.atan2(-Bh, Ah);
    harmonics.push({ h, amp, phase });
  }
  return { mean, harmonics };
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

// The 3 main-chain joints share the 'arm' group (anatomically), but each gets
// its own DISTINCT display color — used for its editor swatch, its curve in
// the Control tab's joint-angle plot, and that plot's legend — so the three
// curves are distinguishable instead of all rendering as the same blue.
// Chosen from the same palette family as GROUP_COLORS but not reused by any
// finger group, to avoid an unrelated on-screen color collision.
const MAIN_JOINT_COLORS = {
  upperArm: '#267aba',
  forearm: '#f5dc69',
  palm: '#c4dd88',
};

/**
 * [proximal, middle, distal] lengths + palm attachment (lateral = along the
 * knuckle line, forward = along the palm's own direction), world units.
 * Lateral spacing is kept generously wide (relative to the finger widths in
 * ui/armSkin.js) so the 5 fingers always render as visibly SEPARATE
 * articulated chains — each its own outline, gaps between them — never as a
 * fused mitten silhouette.
 */
// `forward`/`lateral` are chosen to land INSIDE the palm plate's own rendered
// edge (see ui/armSkin.js's PALM_PROFILE, which is widened to match): the
// palm bone's tip is the knuckle line, so the 4 fingers attach very close to
// it (small `forward`), spread out along it (`lateral`, kept comfortably
// under the palm's knuckle-end half-width so nothing floats past the plate's
// edge), while the thumb attaches further back (negative `forward`, toward
// the wrist half of the palm) and to one side, opposable.
const FINGER_SPEC = [
  { name: 'thumb', group: 'thumb', lengths: [0.05, 0.038, 0.03], lateral: -0.06, forward: -0.045, spread: -55 * DEG },
  { name: 'index', group: 'index', lengths: [0.058, 0.036, 0.026], lateral: -0.05, forward: 0.01, spread: -8 * DEG },
  { name: 'middle', group: 'middle', lengths: [0.064, 0.042, 0.03], lateral: -0.018, forward: 0.015, spread: -1 * DEG },
  { name: 'ring', group: 'ring', lengths: [0.058, 0.038, 0.028], lateral: 0.018, forward: 0.008, spread: 5 * DEG },
  { name: 'little', group: 'little', lengths: [0.046, 0.03, 0.022], lateral: 0.05, forward: 0, spread: 12 * DEG },
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
    { id: 'upperArm', parent: null, length: 0.34, group: 'arm', label: 'Upper arm', color: MAIN_JOINT_COLORS.upperArm, series: seriesFor('upperArm') },
    { id: 'forearm', parent: 'upperArm', length: 0.29, group: 'arm', label: 'Forearm (elbow)', color: MAIN_JOINT_COLORS.forearm, series: seriesFor('forearm') },
    { id: 'palm', parent: 'forearm', length: 0.125, group: 'arm', label: 'Palm (wrist)', color: MAIN_JOINT_COLORS.palm, series: seriesFor('palm') },
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
    // Upper arm raised out to the side and held there; the forearm's mean
    // continues it to roughly vertical (absolute ~90°) and oscillates ±27°
    // about that, which is what actually swings the hand side to side; the
    // palm/wrist follows with a smaller, phase-lagged wobble for a floppy
    // wave rather than a rigid one.
    upperArm: s(80 * DEG, [{ h: 1, amp: 3 * DEG, phase: 0 }]),
    forearm: s(10 * DEG, [{ h: 1, amp: 27 * DEG, phase: 0 }]),
    palm: s(0 * DEG, [{ h: 1, amp: 20 * DEG, phase: -90 * DEG }]),
  };
  const main = buildMainChain((id) => mainSeries[id]);
  const fingers = buildFingerBones('palm', (id, finger, j) => {
    const flutter = { h: 2, amp: 4 * DEG, phase: j * 35 * DEG };
    if (j === 0) return s(finger.spread * 1.3 - 4 * DEG, [flutter]);
    if (j === 1) return s(-4 * DEG, [flutter]);
    return s(-4 * DEG, [flutter]);
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
  const H = 4;
  // Explicit keyframe pose sequence (t = fraction of period; degrees),
  // authored as ABSOLUTE main-chain angles for readability (0° = +x/right,
  // 90° = +y/up), then converted to each bone's own RELATIVE series via
  // fitHarmonics. Holding the SAME pose across two adjacent keyframes (e.g.
  // 0.15 -> 0.25) means the arm stays put there while only the fingers move.
  //   REST   — arm relaxed, hanging forward-down.
  //   TABLE  — reaching down, hand at the table/ball.
  //   LIFTED — arm raised well above TABLE, carrying the (closed) hand.
  // TABLE's palm is near-HORIZONTAL (not pointing down the forearm's own
  // direction): the forearm still angles down to bring the hand to table
  // height, but the wrist bends so the palm (and therefore the fingers,
  // which extend from it) reaches for the ball roughly sideways rather than
  // downward — that's what keeps an OPEN hand's fingertips from extending
  // past the table line before they ever close (see the module-level
  // TABLE_HEADROOM search below, which picks the exact numbers).
  const REST = { upperArm: -50, forearm: 30, palm: 50 };
  const TABLE = { upperArm: -20, forearm: -95, palm: -10 };
  const LIFTED = { upperArm: 45, forearm: 25, palm: 15 };
  // The arm HOLDS the TABLE pose all the way from 0.70 through 0.90 — well
  // past where the fingers finish releasing (see flexShapeDeg below) — so
  // the hand is already stationary at table height before the ball lets go,
  // instead of withdrawing WHILE still (or just barely not) holding it,
  // which would otherwise pop the released ball from mid-air to the table.
  const absKeyframesDeg = {
    upperArm: [[0, REST.upperArm], [0.15, TABLE.upperArm], [0.25, TABLE.upperArm], [0.45, LIFTED.upperArm], [0.55, LIFTED.upperArm], [0.70, TABLE.upperArm], [0.90, TABLE.upperArm], [0.96, REST.upperArm]],
    forearm: [[0, REST.forearm], [0.15, TABLE.forearm], [0.25, TABLE.forearm], [0.45, LIFTED.forearm], [0.55, LIFTED.forearm], [0.70, TABLE.forearm], [0.90, TABLE.forearm], [0.96, REST.forearm]],
    palm: [[0, REST.palm], [0.15, TABLE.palm], [0.25, TABLE.palm], [0.45, LIFTED.palm], [0.55, LIFTED.palm], [0.70, TABLE.palm], [0.90, TABLE.palm], [0.96, REST.palm]],
  };
  const absFn = {};
  for (const id of MAIN_JOINT_IDS) {
    absFn[id] = keyframeFn(absKeyframesDeg[id].map(([t, v]) => [t, v * DEG]));
  }
  // theta_j = theta_parent + q_j  =>  q_j = theta_j - theta_parent.
  const relFn = {
    upperArm: (t) => absFn.upperArm(t),
    forearm: (t) => absFn.forearm(t) - absFn.upperArm(t),
    palm: (t) => absFn.palm(t) - absFn.forearm(t),
  };
  const mainSeries = {};
  for (const id of MAIN_JOINT_IDS) mainSeries[id] = fitHarmonics(relFn[id], H);
  const main = buildMainChain((id) => mainSeries[id]);

  // Finger flex: extended (open) while reaching/withdrawing, closed for the
  // ENTIRE grasp-lift-hold-lower span (0.25 through 0.80) — not just a brief
  // moment at the bottom — which is what lets the closed hand actually carry
  // the ball up to LIFTED and back down again. Identical normalized timeline
  // for all 5 fingers (the "symmetric pose" the grasp relies on — see
  // gesture.test.js), each joint scaled by how much it flexes in a real grip
  // (PIP most, MCP/DIP less).
  const OPEN_DEG = 0;
  const CLOSED_DEG = -75;
  const flexShapeDeg = keyframeFn([[0, OPEN_DEG], [0.15, OPEN_DEG], [0.25, CLOSED_DEG], [0.80, CLOSED_DEG], [0.90, OPEN_DEG]]);
  const JOINT_SCALE = [0.55, 1, 0.8]; // j = 0 (MCP), 1 (PIP), 2 (DIP)
  const JOINT_BASELINE_DEG = [-8, -8, -6];
  const fingers = buildFingerBones('palm', (id, finger, j) => {
    const baselineDeg = j === 0 ? finger.spread / DEG - 8 : JOINT_BASELINE_DEG[j];
    const scale = JOINT_SCALE[j];
    return fitHarmonics((t) => (baselineDeg + flexShapeDeg(t) * scale) * DEG, H);
  });
  return [...main, ...fingers];
}

/** Ids of the 4 main fingers' distal tips + thumb tip, used for the grasp centroid. */
const FINGERTIP_IDS = ['thumb3', 'index3', 'middle3', 'ring3', 'little3'];
const FLEX_JOINT_IDS = ['index2', 'middle2', 'ring2', 'little2'];

/** Ball + table geometry for the "pick up a ball" preset (world units), tuned
 * to where {@link pickupBallBones}'s fingertip centroid actually reaches. */
export const PICKUP = {
  // tableY is set to (a hair below) the LOWEST any joint/fingertip ever
  // reaches across the whole gesture (see gesture.test.js's "nothing crosses
  // the table" check) — nothing may cross below the table line. The ball's
  // RESTING center sits `ballRadius` above that line (bottom tangent to it),
  // near the x the closing hand actually arrives at (the "TABLE" grasp
  // keyframe's fingertip centroid, t=0.25).
  tableY: -0.6,
  ballRestX: 0.415,
  ballRadius: 0.06,
  graspRadius: 0.09,
  tableHalfWidth: 0.2,
  // Deliberately high (close to the ~86° fully-closed flex): the ball's
  // rendered position is the CURRENT fingertip centroid whenever attached,
  // so attach/detach right when the fingers are almost fully closed keeps
  // the position jump at that instant small (a fraction of the ball's own
  // radius) instead of popping from wherever a still-mostly-open hand is.
  flexThreshold: 65 * DEG,
  // The exact t of pickupBallBones()'s "TABLE" grasp keyframe — see pickupBallState.
  graspT: 0.25,
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
function fingertipCentroid(fk) {
  let cx = 0;
  let cy = 0;
  for (const id of FINGERTIP_IDS) {
    const p = fk.get(id).tip;
    cx += p.re;
    cy += p.im;
  }
  return { re: cx / FINGERTIP_IDS.length, im: cy / FINGERTIP_IDS.length };
}

function flexAmount(fk) {
  let flex = 0;
  for (const id of FLEX_JOINT_IDS) flex += -fk.get(id).relAngle;
  return flex / FLEX_JOINT_IDS.length;
}

export function pickupBallState(bones, t, pickup = PICKUP) {
  // The ball's RESTING center: `ballRadius` above the table line, so its
  // bottom is exactly tangent to it (never crossing below).
  const restPos = { re: pickup.ballRestX, im: pickup.tableY + pickup.ballRadius };
  const fk = forwardKinematics(bones, t);
  const tip = fingertipCentroid(fk);
  const flex = flexAmount(fk);
  const dist = Math.hypot(tip.re - restPos.re, tip.im - restPos.im);
  // Whether the grasp SUCCEEDS at all is decided once, at the gesture's own
  // authored grasp instant (`graspT`) — not by comparing every t's (possibly
  // already-lifted, far-away) hand position to the table. This is what lets
  // the ball travel far from the table while still attached (a real grasp
  // carries the object with the hand, it doesn't need to stay near where it
  // was picked up), while still correctly failing to grasp at all when a
  // band-limited/filtered `bones` never reaches the ball in the first place
  // (the grasp-instant distance stays large for every t, so `attached` is
  // false for the whole period).
  const graspFk = forwardKinematics(bones, pickup.graspT);
  const graspTip = fingertipCentroid(graspFk);
  const graspDist = Math.hypot(graspTip.re - restPos.re, graspTip.im - restPos.im);
  const attached = graspDist < pickup.graspRadius && flex > pickup.flexThreshold;
  const pos = attached ? tip : restPos;
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
