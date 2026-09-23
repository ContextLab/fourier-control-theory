/**
 * Stylized vector "skin" rendering for the robot-arm puppet. Given pixel-space
 * joint positions (the Fourier-component "bones"), draws a smooth, shaded
 * human-arm-like silhouette that deforms continuously as the joints move —
 * shoulder -> upper arm -> forearm -> palm (with thumb) -> a fanned set of
 * fingers (index driven by the real Finger/Fingertip bones, the other three
 * rigidly following its angles) -> fingertip, with any additional bones
 * drawn as tapering tentacle-like continuations. Pure Canvas 2D vector
 * paths; no images.
 *
 * Anatomical proportions (upper arm, forearm, palm, finger widths) are all
 * derived from a single global scale — `armScale`, the pixel length of the
 * upper-arm + forearm bones — rather than each bone's own length. This is
 * what keeps the hand and fingers slender and readable even though their
 * *own* Fourier amplitudes (and therefore bone lengths) are small and
 * rotate independently: a short, oddly-angled finger bone still gets a
 * finger-sized width instead of inflating into a round blob.
 *
 * All pieces (limb tube, palm, thumb, fingers) are built as `Path2D` objects
 * and rendered as a single opaque union: every outline is stroked FIRST (at
 * double the visible width), then every piece is filled solid on top.
 * Because the fill exactly covers the inner half of its own stroke, only the
 * half that isn't covered by *some* piece's fill survives — i.e. the
 * outline of the boolean union, with no seams where pieces overlap.
 * @module ui/armSkin
 */

const DEFAULT_COLORS = {
  skin: '#e3ac81',
  skinShade: '#b17a51',
  outline: '#5c3524',
  bone: '#8a6996',
};

const SAMPLES_PER_BONE = 8;
const BLEND = 0.22; // fraction of each bone's own parameter range blended toward the joint value
const MIN_HALF_PX = 8; // absolute floor on every drawn half-width, in the same px space as joint handles (radius <= 7px)

// -- Anatomical taper tables, all expressed as a FRACTION OF `armScale` (the
// combined pixel length of the upper-arm + forearm bones) rather than of
// each bone's own length. [u, fraction] control points, u in [0,1] along
// the piece from its proximal (near-body) end to its distal (far) end.

const LIMB_PROFILES = {
  // Deltoid -> bicep -> narrowing toward the elbow. No separate shoulder
  // "cap" ellipse is drawn (that read as a bulbous knob); the taper itself
  // plus the round end-cap sells the shoulder.
  upperArm: [
    [0, 0.16],
    [0.15, 0.148],
    [0.5, 0.125],
    [0.85, 0.1],
    [1, 0.09],
  ],
  // Elbow -> forearm muscle -> narrow wrist.
  forearm: [
    [0, 0.09],
    [0.25, 0.085],
    [0.6, 0.07],
    [1, 0.048],
  ],
};

// Palm: a slender trapezoid (narrower at the wrist, a touch wider across
// the knuckles) with rounded corners (from the joint-cap circles). Kept
// narrow relative to the limb and to the fingers' reach past it, so the
// fingers read as fingers rather than being swallowed into a fat mitt.
const PALM_PROFILE = [
  [0, 0.062],
  [0.4, 0.082],
  [1, 0.078],
];

// Finger phalanges: narrow and only mildly tapered (~0.2-0.3x palm width).
const FINGER_PROFILES = {
  phalanx1: [
    [0, 0.034],
    [1, 0.027],
  ],
  phalanx2: [
    [0, 0.026],
    [1, 0.018],
  ],
};

const THUMB_PROFILE = [
  [0, 0.036],
  [1, 0.026],
];

// Per-finger variety for the three siblings that fan out alongside the real
// (index) finger: [lengthScale, extraAngle (rad, rigid rotation of the
// whole finger about its own base), lateralSlots (how many finger-spacings
// from the index finger's real anchor, toward the thumb-opposite side)].
const SIBLING_FINGERS = [
  { lengthScale: 1.04, extraAngle: 0.02, slots: 1, widthScale: 0.95 }, // middle
  { lengthScale: 0.92, extraAngle: -0.06, slots: 2, widthScale: 0.88 }, // ring
  { lengthScale: 0.76, extraAngle: -0.14, slots: 3, widthScale: 0.78 }, // pinky
];

// -- small vector helpers -----------------------------------------------

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(a, s) {
  return { x: a.x * s, y: a.y * s };
}
function lerp(a, b, u) {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
function vlen(a) {
  return Math.hypot(a.x, a.y);
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}
function safeNorm(a, fallback) {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : fallback;
}
function normalOf(dir) {
  return { x: -dir.y, y: dir.x };
}
function rotate(dir, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c };
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function smoothstep(t) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}
function isFinitePt(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function profileAt(points, u) {
  const uc = clamp(u, 0, 1);
  for (let i = 0; i < points.length - 1; i++) {
    const [u0, v0] = points[i];
    const [u1, v1] = points[i + 1];
    if (uc >= u0 && uc <= u1) {
      const t = u1 > u0 ? (uc - u0) / (u1 - u0) : 0;
      return v0 + (v1 - v0) * smoothstep(t);
    }
  }
  return points[points.length - 1][1];
}

/** Draws a smooth curve through `pts` (quadratic-curve-through-midpoints), continuing an open path. */
function curveThrough(target, pts) {
  if (pts.length === 0) return;
  target.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    target.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    target.lineTo(last.x, last.y);
  }
}

/** Draws a round cap (semicircle) at `center`, bulging outward in the +dir direction. */
function drawRoundCap(target, center, normal, dir, radius) {
  if (radius <= 0) return;
  const a0 = Math.atan2(normal.y, normal.x);
  const a1 = Math.atan2(-normal.y, -normal.x);
  const midAngle = a0 + Math.PI / 2;
  const mid = { x: Math.cos(midAngle), y: Math.sin(midAngle) };
  const d = mid.x * dir.x + mid.y * dir.y;
  const anticlockwise = d < 0;
  target.arc(center.x, center.y, radius, a0, a1, anticlockwise);
}

function circlePath(center, r) {
  const p = new Path2D();
  p.arc(center.x, center.y, Math.max(0, r), 0, Math.PI * 2);
  return p;
}

/**
 * Build a tapered tube through an explicit chain of points (not necessarily
 * the raw joint chain — used both for the real bone chain and for the
 * fan-out sibling fingers, which are rigid copies anchored elsewhere).
 * @param {{x:number,y:number}[]} points - length segCount + 1
 * @param {{x:number,y:number}[]} dirs - unit directions, length segCount
 * @param {(seg:number, u:number) => number} widthAt - half-width for segment `seg` at param u in [0,1]
 * @param {number} minHalf
 * @param {number} maxHalf
 */
function buildTube(points, dirs, widthAt, minHalf, maxHalf) {
  const count = dirs.length;
  const nrms = dirs.map(normalOf);
  const jn = new Array(count + 1);
  jn[0] = nrms[0];
  jn[count] = nrms[count - 1];
  for (let k = 1; k < count; k++) {
    jn[k] = safeNorm(add(nrms[k - 1], nrms[k]), nrms[k - 1]);
  }
  const jw = new Array(count + 1);
  jw[0] = clamp(widthAt(0, 0), minHalf, maxHalf);
  jw[count] = clamp(widthAt(count - 1, 1), minHalf, maxHalf);
  for (let k = 1; k < count; k++) {
    jw[k] = clamp((widthAt(k - 1, 1) + widthAt(k, 0)) / 2, minHalf, maxHalf);
  }
  const leftPts = [];
  const rightPts = [];
  for (let k = 0; k < count; k++) {
    const p0 = points[k];
    const p1 = points[k + 1];
    const startS = k === 0 ? 0 : 1;
    for (let s = startS; s <= SAMPLES_PER_BONE; s++) {
      const u = s / SAMPLES_PER_BONE;
      const a0 = u < BLEND ? 1 - smoothstep(u / BLEND) : 0;
      const a1 = u > 1 - BLEND ? smoothstep((u - (1 - BLEND)) / BLEND) : 0;
      const aOwn = 1 - a0 - a1;
      let nrm = {
        x: nrms[k].x * aOwn + jn[k].x * a0 + jn[k + 1].x * a1,
        y: nrms[k].y * aOwn + jn[k].y * a0 + jn[k + 1].y * a1,
      };
      nrm = safeNorm(nrm, nrms[k]);
      const width = clamp(widthAt(k, u) * aOwn + jw[k] * a0 + jw[k + 1] * a1, minHalf, maxHalf);
      const point = lerp(p0, p1, u);
      leftPts.push(add(point, scale(nrm, width)));
      rightPts.push(add(point, scale(nrm, -width)));
    }
  }
  return { leftPts, rightPts, jointNormal: jn, jointWidth: jw };
}

/** Turns a `buildTube()` result into a closed Path2D, with optional round caps at each end. */
function tubeToPath(tube, startCap, endCap) {
  const path = new Path2D();
  path.moveTo(tube.leftPts[0].x, tube.leftPts[0].y);
  curveThrough(path, tube.leftPts.slice(1));
  if (endCap) drawRoundCap(path, endCap.center, endCap.normal, endCap.dir, endCap.width);
  curveThrough(path, tube.rightPts.slice().reverse());
  if (startCap) drawRoundCap(path, startCap.center, startCap.normal, startCap.dir, startCap.width);
  path.closePath();
  return path;
}

/**
 * `true` iff every component carries a `label` string — i.e. this is the
 * anatomical human-arm preset (as opposed to an arbitrary Fourier chain),
 * the only case in which the skin should be drawn.
 * @param {Array<object>} components
 * @returns {boolean}
 */
export function isAnatomical(components) {
  return Array.isArray(components) && components.length > 0
    && components.every((c) => c && typeof c.label === 'string');
}

/**
 * Draw a stylized vector human-arm skin over the given chain of joints.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}[]} jointsPx - pixel positions p_0 (shoulder) .. p_n (tip)
 * @param {{scalePx?:number, colors?:object, xray?:boolean, selectedIndex?:number}} [opts]
 */
export function drawArmSkin(ctx, jointsPx, opts = {}) {
  if (!Array.isArray(jointsPx) || jointsPx.length < 2 || jointsPx.some((p) => !isFinitePt(p))) {
    return;
  }
  const colors = { ...DEFAULT_COLORS, ...(opts.colors || {}) };
  const xray = !!opts.xray;
  const n = jointsPx.length - 1;

  // Per-bone unit directions (guarding zero-length bones by reusing the
  // previous direction, so a degenerate pose never divides by zero).
  const dirs = [];
  {
    let prevDir = { x: 1, y: 0 };
    for (let i = 0; i < n; i++) {
      const raw = sub(jointsPx[i + 1], jointsPx[i]);
      const len = vlen(raw);
      const d = len > 1e-6 ? { x: raw.x / len, y: raw.y / len } : prevDir;
      prevDir = d;
      dirs.push(d);
    }
  }

  // Global scale: the upper-arm + forearm pixel length when both are
  // present. Every other piece's width is a fraction of THIS, not of its
  // own (possibly tiny, independently-rotating) bone length — that's what
  // keeps a short, oddly-angled hand/finger bone reading as a slender hand
  // or finger instead of inflating into a round blob.
  let armScale;
  if (n >= 2) {
    armScale = vlen(sub(jointsPx[1], jointsPx[0])) + vlen(sub(jointsPx[2], jointsPx[1]));
  } else if (n === 1) {
    armScale = vlen(sub(jointsPx[1], jointsPx[0])) * 2;
  } else {
    armScale = 0;
  }
  if (!(armScale > 1e-6)) armScale = opts.scalePx ? opts.scalePx * 0.8 : 80;
  armScale = clamp(armScale, 16, 1600);

  const MIN_HALF = Math.max(1.5, MIN_HALF_PX);
  const MAX_HALF = Math.max(armScale * 0.6, MIN_HALF);

  const pieces = []; // Path2D list: stroked (outline) then filled (opaque union)
  const capPieces = []; // small circular seam-blend caps, filled only

  // -- Upper arm (+ forearm): one continuous tapered tube ------------------
  const limbCount = Math.min(n, 2);
  const limbPoints = jointsPx.slice(0, limbCount + 1);
  const limbDirs = dirs.slice(0, limbCount);
  const limbWidthAt = (seg, u) => {
    const profile = seg === 0 ? LIMB_PROFILES.upperArm : LIMB_PROFILES.forearm;
    return armScale * profileAt(profile, u);
  };
  const limbTube = buildTube(limbPoints, limbDirs, limbWidthAt, MIN_HALF, MAX_HALF);
  const shoulderCap = {
    center: jointsPx[0],
    normal: limbTube.jointNormal[0],
    dir: { x: -limbDirs[0].x, y: -limbDirs[0].y },
    width: limbTube.jointWidth[0],
  };
  const hasHand = n >= 3;
  const limbTipCap = hasHand
    ? null
    : { center: jointsPx[limbCount], normal: limbTube.jointNormal[limbCount], dir: limbDirs[limbCount - 1], width: limbTube.jointWidth[limbCount] };
  pieces.push(tubeToPath(limbTube, shoulderCap, limbTipCap));
  if (limbCount === 2) capPieces.push(circlePath(jointsPx[1], limbTube.jointWidth[1] * 1.05));

  // -- Palm: a rounded trapezoid from the wrist to the knuckles ------------
  let palmTube = null;
  let handDir = null;
  let knuckleNormal = null;
  if (hasHand) {
    handDir = dirs[2];
    knuckleNormal = normalOf(handDir);
    const palmPoints = jointsPx.slice(2, 4);
    const palmWidthAt = (_seg, u) => armScale * profileAt(PALM_PROFILE, u);
    palmTube = buildTube(palmPoints, [handDir], palmWidthAt, MIN_HALF, MAX_HALF);
    const hasFingers = n >= 4;
    const knuckleCap = hasFingers ? null : { center: jointsPx[3], normal: palmTube.jointNormal[1], dir: handDir, width: palmTube.jointWidth[1] };
    pieces.push(tubeToPath(palmTube, null, knuckleCap));
    capPieces.push(circlePath(jointsPx[2], palmTube.jointWidth[0] * 1.05));
  }

  // -- Thumb: rigid child of the palm, angled off to one side --------------
  let thumbDir = null;
  if (hasHand) {
    const wrist = jointsPx[2];
    const knuckle = jointsPx[3];
    const thumbBase = lerp(wrist, knuckle, 0.32);
    thumbDir = rotate(handDir, -1.0);
    const thumbLen = armScale * 0.15;
    const thumbTip = add(thumbBase, scale(thumbDir, thumbLen));
    const thumbWidthAt = (_seg, u) => armScale * profileAt(THUMB_PROFILE, u);
    const thumbTube = buildTube([thumbBase, thumbTip], [thumbDir], thumbWidthAt, MIN_HALF * 0.9, MAX_HALF);
    const thumbTipCap = { center: thumbTip, normal: thumbTube.jointNormal[1], dir: thumbDir, width: thumbTube.jointWidth[1] };
    pieces.push(tubeToPath(thumbTube, null, thumbTipCap));
    capPieces.push(circlePath(thumbBase, thumbTube.jointWidth[0] * 1.1));
  }

  // -- Fingers: the real (index) finger follows bones 3 (Finger) and 4
  // (Fingertip) exactly — so their draggable joint handles stay visible and
  // inside the skin — while three rigid sibling fingers fan out alongside
  // it, reusing the SAME proximal/distal angles with small offsets, so the
  // hand reads as a hand with fingers rather than a single digit. Widths
  // come from `armScale`, not from these (often tiny) bones' own length.
  const fingerTips = []; // {point, dir} for fingernail placement (real finger only)
  let realFingerLastIdx = -1;
  if (hasHand && n >= 4) {
    const fingerSegCount = Math.min(n - 3, 2); // 1 (phalanx1 only) or 2 (phalanx1+phalanx2)
    const fingerPoints = jointsPx.slice(3, 3 + fingerSegCount + 1);
    const fingerDirs = dirs.slice(3, 3 + fingerSegCount);
    const fingerWidthAt = (seg, u) => {
      const profile = seg === 0 ? FINGER_PROFILES.phalanx1 : FINGER_PROFILES.phalanx2;
      return armScale * profileAt(profile, u);
    };
    const fingerTube = buildTube(fingerPoints, fingerDirs, fingerWidthAt, MIN_HALF * 0.85, MAX_HALF);
    const tipCap = {
      center: fingerPoints[fingerSegCount],
      normal: fingerTube.jointNormal[fingerSegCount],
      dir: fingerDirs[fingerSegCount - 1],
      width: fingerTube.jointWidth[fingerSegCount],
    };
    pieces.push(tubeToPath(fingerTube, null, tipCap));
    capPieces.push(circlePath(jointsPx[3], fingerTube.jointWidth[0] * 1.05));
    if (fingerSegCount === 2) capPieces.push(circlePath(jointsPx[4], fingerTube.jointWidth[1] * 1.05));
    fingerTips.push({ point: fingerPoints[fingerSegCount], dir: fingerDirs[fingerSegCount - 1] });
    realFingerLastIdx = 3 + fingerSegCount - 1;

    // Sibling fingers (only once a full hand — palm + both phalanges — is
    // present): rigid copies of the real finger's directions, anchored at
    // evenly-spaced points along the knuckle line, fanning away from the
    // thumb, with small per-finger length/angle variety.
    if (fingerSegCount === 2) {
      const thumbSide = thumbDir ? -Math.sign(dot(thumbDir, knuckleNormal)) || 1 : 1;
      const spacing = armScale * 0.032;
      const knuckle = jointsPx[3];
      for (const sib of SIBLING_FINGERS) {
        const base = add(knuckle, scale(knuckleNormal, thumbSide * spacing * sib.slots));
        const dA = rotate(fingerDirs[0], sib.extraAngle);
        const dB = rotate(fingerDirs[1], sib.extraAngle);
        const lenA = vlen(sub(fingerPoints[1], fingerPoints[0])) * sib.lengthScale;
        const lenB = vlen(sub(fingerPoints[2], fingerPoints[1])) * sib.lengthScale;
        const pMid = add(base, scale(dA, lenA));
        const pTip = add(pMid, scale(dB, lenB));
        const sibWidthAt = (seg, u) => {
          const profile = seg === 0 ? FINGER_PROFILES.phalanx1 : FINGER_PROFILES.phalanx2;
          return armScale * profileAt(profile, u) * sib.widthScale;
        };
        const sibTube = buildTube([base, pMid, pTip], [dA, dB], sibWidthAt, MIN_HALF * 0.8, MAX_HALF);
        const sibTipCap = { center: pTip, normal: sibTube.jointNormal[2], dir: dB, width: sibTube.jointWidth[2] };
        pieces.push(tubeToPath(sibTube, null, sibTipCap));
        capPieces.push(circlePath(base, sibTube.jointWidth[0] * 1.05));
        capPieces.push(circlePath(pMid, sibTube.jointWidth[1] * 1.05));
      }
    }
  }

  // -- Any bones beyond the fingertip: thin tapering tentacle continuation -
  const tentacleStart = hasHand ? 3 + Math.min(n - 3, 2) : limbCount;
  if (n > tentacleStart) {
    const tentaclePoints = jointsPx.slice(tentacleStart, n + 1);
    const tentacleDirs = dirs.slice(tentacleStart, n);
    const baseWidth = armScale * 0.05;
    const tentacleWidthAt = (seg, u) => baseWidth * Math.pow(0.82, seg) * (1 - 0.3 * u);
    const tentacleTube = buildTube(tentaclePoints, tentacleDirs, tentacleWidthAt, MIN_HALF * 0.7, MAX_HALF);
    const lastSeg = tentacleDirs.length - 1;
    const tentacleTipCap = {
      center: jointsPx[n],
      normal: tentacleTube.jointNormal[tentacleDirs.length],
      dir: tentacleDirs[lastSeg],
      width: tentacleTube.jointWidth[tentacleDirs.length],
    };
    pieces.push(tubeToPath(tentacleTube, null, tentacleTipCap));
    capPieces.push(circlePath(jointsPx[tentacleStart], tentacleTube.jointWidth[0] * 1.05));
  }

  // The skin itself is always drawn fully opaque (that's the whole point of
  // the union-outline trick above — no seams). `xray` only controls whether
  // the thin bone struts are drawn translucently on TOP of it, afterward.
  ctx.save();
  ctx.lineJoin = 'round';

  // -- Pass 1: stroke every outline FIRST, at double the visible width. ----
  // The fill pass (below) covers the inner half of each stroke; only the
  // half not covered by any piece's fill survives, which is exactly the
  // outline of the boolean union, no seams where pieces overlap.
  const outlineW = Math.max(1, armScale * 0.018);
  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = outlineW * 2;
  for (const p of pieces) ctx.stroke(p);

  // -- Pass 2: fill every piece (and seam-blend cap) solid, opaque, on top. -
  ctx.fillStyle = colors.skin;
  for (const cp of capPieces) ctx.fill(cp);
  for (const p of pieces) ctx.fill(p, 'nonzero');

  // -- Decorative overlays, drawn on top of the finished opaque union. -----

  // Subtle one-sided shading along the "far" side of the limb + palm.
  ctx.beginPath();
  ctx.moveTo(limbTube.rightPts[0].x, limbTube.rightPts[0].y);
  curveThrough(ctx, limbTube.rightPts.slice(1));
  if (palmTube) curveThrough(ctx, palmTube.rightPts);
  ctx.strokeStyle = colors.skinShade;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(1, armScale * 0.03);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Small crease line at the elbow and (if present) the wrist.
  const creaseJoints = [];
  if (limbCount === 2) creaseJoints.push(1);
  if (hasHand) creaseJoints.push(2);
  for (const j of creaseJoints) {
    const p = jointsPx[j];
    const dPrev = dirs[j - 1];
    const dNext = dirs[j];
    const nrm = j === 1 ? limbTube.jointNormal[1] : palmTube.jointNormal[0];
    const r = j === 1 ? limbTube.jointWidth[1] : palmTube.jointWidth[0];
    const cosAngle = clamp(dot(dPrev, dNext), -1, 1);
    const fold = clamp((1 - cosAngle) / 2, 0, 1);
    const cross = dPrev.x * dNext.y - dPrev.y * dNext.x;
    const side = cross >= 0 ? -1 : 1;
    const creaseCenter = add(p, scale(nrm, r * 0.55 * side));
    const creaseAngle = Math.atan2(nrm.y, nrm.x);
    ctx.beginPath();
    ctx.arc(creaseCenter.x, creaseCenter.y, r * (0.35 + fold * 0.15), creaseAngle - 0.9, creaseAngle + 0.9);
    ctx.strokeStyle = colors.skinShade;
    ctx.lineWidth = Math.max(1, armScale * 0.012);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Fingernail on the real fingertip.
  if (fingerTips.length && realFingerLastIdx >= 0) {
    const tip = fingerTips[0];
    const tipWidth = Math.max(MIN_HALF * 0.85, armScale * profileAt(FINGER_PROFILES.phalanx2, 1));
    const tipNormal = normalOf(tip.dir);
    const nailBase = jointsPx[realFingerLastIdx];
    const nailCenter = add(lerp(nailBase, tip.point, 0.72), scale(tipNormal, tipWidth * 0.3));
    const nailR = Math.max(1.5, tipWidth * 0.42);
    ctx.beginPath();
    ctx.ellipse(nailCenter.x, nailCenter.y, nailR * 0.85, nailR * 0.55, Math.atan2(tip.dir.y, tip.dir.x), 0, Math.PI * 2);
    ctx.strokeStyle = colors.outline;
    ctx.lineWidth = Math.max(0.75, armScale * 0.008);
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // X-ray: show the underlying bone struts, thin and translucent, on top of
  // the now fully-opaque skin.
  if (xray) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = colors.bone;
    ctx.lineWidth = Math.max(1, armScale * 0.014);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(jointsPx[i].x, jointsPx[i].y);
      ctx.lineTo(jointsPx[i + 1].x, jointsPx[i + 1].y);
    }
    ctx.stroke();
    for (let j = 0; j <= n; j++) {
      ctx.beginPath();
      ctx.arc(jointsPx[j].x, jointsPx[j].y, Math.max(2, armScale * 0.017), 0, Math.PI * 2);
      ctx.fillStyle = colors.bone;
      ctx.fill();
    }
    ctx.restore();
  }

  // Selection highlight.
  if (Number.isInteger(opts.selectedIndex) && opts.selectedIndex >= 0 && opts.selectedIndex < n) {
    const p0 = jointsPx[opts.selectedIndex];
    const p1 = jointsPx[opts.selectedIndex + 1];
    ctx.save();
    ctx.strokeStyle = '#ffcc33';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(1.5, armScale * 0.012);
    ctx.setLineDash([armScale * 0.03, armScale * 0.02]);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [p0, p1]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, armScale * 0.022), 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc33';
      ctx.fill();
    }
    ctx.restore();
  }
}
