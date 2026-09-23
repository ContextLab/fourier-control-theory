import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evalSeries,
  forwardKinematics,
  sampleTipPath,
  jointAngleSeries,
  buildMainChain,
  buildFingerBones,
  waveHelloBones,
  pickupBallBones,
  pickupBallState,
  filterSeries,
  filterBones,
  PICKUP,
  MAIN_JOINT_IDS,
  ALL_JOINT_IDS,
  FINGER_NAMES,
} from '../../js/core/gesture.js';
import { jointPositions } from '../../js/core/arm.js';

function close(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b} (eps ${eps})`);
}

// --- tree structure ---------------------------------------------------

test('the full tree has 3 main joints + 5 fingers x 3 joints = 18 bones', () => {
  assert.equal(MAIN_JOINT_IDS.length, 3);
  assert.equal(FINGER_NAMES.length, 5);
  assert.equal(ALL_JOINT_IDS.length, 18);
  for (const name of FINGER_NAMES) {
    for (const j of [1, 2, 3]) assert.ok(ALL_JOINT_IDS.includes(`${name}${j}`));
  }
  const wave = waveHelloBones();
  const pickup = pickupBallBones();
  assert.equal(wave.length, 18);
  assert.equal(pickup.length, 18);
});

// --- forward kinematics correctness ------------------------------------

test('forwardKinematics: a single bone at the origin lands at length*e^{i*angle}', () => {
  const bones = [{ id: 'a', parent: null, length: 2, group: 'arm', label: 'a', series: { mean: Math.PI / 3, harmonics: [] } }];
  const fk = forwardKinematics(bones, 0);
  const a = fk.get('a');
  assert.deepEqual(a.base, { re: 0, im: 0 });
  close(a.tip.re, 2 * Math.cos(Math.PI / 3));
  close(a.tip.im, 2 * Math.sin(Math.PI / 3));
  close(a.absAngle, Math.PI / 3);
});

test('forwardKinematics: a 2-bone chain accumulates relative angles into an absolute angle', () => {
  const bones = [
    { id: 'a', parent: null, length: 1, series: { mean: 0.4, harmonics: [] } },
    { id: 'b', parent: 'a', length: 1, series: { mean: 0.3, harmonics: [] } },
  ];
  const fk = forwardKinematics(bones, 0);
  const a = fk.get('a');
  const b = fk.get('b');
  close(a.absAngle, 0.4);
  close(b.absAngle, 0.7); // 0.4 + 0.3, matching theta_j = sum_{i<=j} q_i
  close(b.base.re, a.tip.re);
  close(b.base.im, a.tip.im);
  close(b.tip.re, a.tip.re + Math.cos(0.7));
  close(b.tip.im, a.tip.im + Math.sin(0.7));
});

test('forwardKinematics: lateral/forward attachment offsets place the base off the parent tip', () => {
  const bones = [
    { id: 'palm', parent: null, length: 1, series: { mean: 0, harmonics: [] } },
    { id: 'finger', parent: 'palm', length: 0.5, lateralOffset: 0.2, forwardOffset: 0.1, series: { mean: 0, harmonics: [] } },
  ];
  const fk = forwardKinematics(bones, 0);
  const palm = fk.get('palm'); // absAngle 0, tip at (1, 0)
  const finger = fk.get('finger');
  // perpendicular to angle 0 is (0, 1); forward is (1, 0).
  close(finger.base.re, palm.tip.re + 0.1);
  close(finger.base.im, palm.tip.im + 0.2);
});

test('forwardKinematics: an explicit root re-anchors parent-less bones (used to overlay a hand)', () => {
  const bones = [{ id: 'f', parent: null, length: 1, series: { mean: 0, harmonics: [] } }];
  const root = { absAngle: Math.PI / 2, tip: { re: 3, im: 4 } };
  const fk = forwardKinematics(bones, 0, { root });
  const f = fk.get('f');
  close(f.base.re, 3);
  close(f.base.im, 4);
  close(f.absAngle, Math.PI / 2);
  close(f.tip.re, 3 + Math.cos(Math.PI / 2));
  close(f.tip.im, 4 + Math.sin(Math.PI / 2));
});

// --- periodicity ---------------------------------------------------------

test('evalSeries and forwardKinematics are periodic: p(t) === p(t+1) for gesture presets', () => {
  for (const bones of [waveHelloBones(), pickupBallBones()]) {
    for (const t of [0, 0.13, 0.37, 0.5, 0.81]) {
      const fk0 = forwardKinematics(bones, t);
      const fk1 = forwardKinematics(bones, t + 1);
      for (const bone of bones) {
        const p0 = fk0.get(bone.id).tip;
        const p1 = fk1.get(bone.id).tip;
        close(p1.re, p0.re, 1e-4);
        close(p1.im, p0.im, 1e-4);
      }
    }
  }
});

test('sampleTipPath returns a length-2M periodic sample of one bone\'s tip', () => {
  const bones = waveHelloBones();
  const path = sampleTipPath(bones, 'middle3', 100);
  assert.equal(path.length, 200);
  // Re-derive sample 0 directly from FK and compare.
  const fk = forwardKinematics(bones, 0);
  close(path[0], fk.get('middle3').tip.re);
  close(path[1], fk.get('middle3').tip.im);
});

// --- symmetric-pose property (the grasp relies on this) -------------------

test('pickupBallBones: all five fingers share an identical flex curve (symmetric grasp pose)', () => {
  const bones = pickupBallBones();
  const names = FINGER_NAMES;
  for (const t of [0, 0.2, 0.5, 0.7, 0.95]) {
    const fk = forwardKinematics(bones, t);
    const rel2 = names.map((n) => fk.get(`${n}2`).relAngle);
    for (let i = 1; i < rel2.length; i++) close(rel2[i], rel2[0], 1e-9);
  }
});

test('pickupBallState: the ball attaches during the grasp window and rises above the table', () => {
  const bones = pickupBallBones();
  const attachedTs = [];
  let maxRise = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const st = pickupBallState(bones, t);
    if (st.attached) {
      attachedTs.push(t);
      maxRise = Math.max(maxRise, st.pos.im - PICKUP.tableY);
    }
  }
  assert.ok(attachedTs.length > 0, 'the ball must attach at some point in the period');
  assert.ok(maxRise > 0.02, `ball must visibly rise above the table while grasped, got ${maxRise}`);
});

test('pickupBallState: at rest (not attached) the ball sits exactly at its table resting spot', () => {
  const bones = pickupBallBones();
  const st = pickupBallState(bones, 0);
  assert.equal(st.attached, false);
  assert.equal(st.pos.re, PICKUP.ballRestX);
  assert.equal(st.pos.im, PICKUP.tableY);
});

// --- wave hello sanity: human-ish joint ranges, tip oscillates ------------

test('waveHelloBones: the elbow stays within a human-ish range and the fingertip x oscillates', () => {
  const bones = waveHelloBones();
  let minElbow = Infinity;
  let maxElbow = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const fk = forwardKinematics(bones, t);
    const rel = fk.get('forearm').relAngle;
    minElbow = Math.min(minElbow, rel);
    maxElbow = Math.max(maxElbow, rel);
    const tip = fk.get('middle3').tip;
    minX = Math.min(minX, tip.re);
    maxX = Math.max(maxX, tip.re);
  }
  const maxAbsElbowDeg = Math.max(Math.abs(minElbow), Math.abs(maxElbow)) * (180 / Math.PI);
  assert.ok(maxAbsElbowDeg < 170, `elbow relative angle must stay < 170deg, got ${maxAbsElbowDeg}`);
  assert.ok(maxX - minX > 0.05, 'fingertip x must visibly oscillate over the period');
});

// --- editor/spectrum metadata ---------------------------------------------

test('jointAngleSeries exposes id/label/group/color/series for every bone', () => {
  const bones = waveHelloBones();
  const meta = jointAngleSeries(bones);
  assert.equal(meta.length, 18);
  for (const m of meta) {
    assert.ok(m.id && m.label && m.group && m.color);
    assert.ok(m.series && typeof m.series.mean === 'number' && Array.isArray(m.series.harmonics));
  }
});

// --- Control-tab bandwidth/lag filtering ----------------------------------

test('filterSeries: B=0 drops every harmonic, leaving only the mean (freezes the joint)', () => {
  const series = { mean: 0.5, harmonics: [{ h: 1, amp: 0.3, phase: 0 }, { h: 2, amp: 0.1, phase: 1 }] };
  const filtered = filterSeries(series, 0, false, 5);
  assert.equal(filtered.mean, 0.5);
  assert.deepEqual(filtered.harmonics, []);
});

test('filterSeries: harmonics with h > B are dropped, h <= B survive', () => {
  const series = { mean: 0, harmonics: [{ h: 1, amp: 1, phase: 0 }, { h: 2, amp: 1, phase: 0 }, { h: 3, amp: 1, phase: 0 }] };
  const filtered = filterSeries(series, 2, false, 5);
  assert.deepEqual(filtered.harmonics.map((h) => h.h), [1, 2]);
});

test('filterSeries: actuator lag shrinks amplitude and phase-lags each surviving harmonic by H(h) = 1/(1+i h/fc)', () => {
  const series = { mean: 0, harmonics: [{ h: 2, amp: 1, phase: 0 }] };
  const fc = 2;
  const filtered = filterSeries(series, 4, true, fc);
  const h = filtered.harmonics[0];
  const expectedMag = 1 / Math.sqrt(1 + (2 / fc) ** 2);
  const expectedPhase = -Math.atan2(2 / fc, 1);
  close(h.amp, expectedMag);
  close(h.phase, expectedPhase);
});

test('filterBones applies filterSeries to every bone independently', () => {
  const bones = pickupBallBones();
  const filtered = filterBones(bones, 1, false, 5);
  for (const b of filtered) {
    for (const h of b.series.harmonics) assert.ok(h.h <= 1);
  }
  // Anatomy (length, parent, attachment) is untouched.
  for (let i = 0; i < bones.length; i++) {
    assert.equal(filtered[i].length, bones[i].length);
    assert.equal(filtered[i].parent, bones[i].parent);
  }
});

// --- spin mode as a special case -----------------------------------------
//
// Gesture mode intentionally does NOT support spin mode's unbounded, linear-
// in-t angle (theta = phase + 2*pi*freq*t) -- only a periodic, bounded sum of
// a few harmonics -- which is exactly why spin mode can't produce a human
// gesture (every joint eventually sweeps a full circle) and gesture mode can.
// The one point where they DO agree is freq = 0: spin mode's theta reduces to
// a constant angle, which is precisely a zero-harmonic gesture joint.
test('spin mode (core/arm.js) with freq=0 is the freq=0 special case of a gesture joint', () => {
  const phase = 0.85;
  const length = 0.6;
  const spinComponents = [{ freq: 0, amp: length, phase }];
  const gestureBones = [{ id: 'a', parent: null, length, series: { mean: phase, harmonics: [] } }];
  for (const t of [0, 0.3, 0.71, 0.99]) {
    const spinTip = jointPositions(spinComponents, t)[1];
    const gestureTip = forwardKinematics(gestureBones, t).get('a').tip;
    close(spinTip.re, gestureTip.re);
    close(spinTip.im, gestureTip.im);
  }
});
