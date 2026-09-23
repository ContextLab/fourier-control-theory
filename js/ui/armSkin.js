/**
 * Stylized vector "skin" rendering for the robot-arm puppet. Given pixel-space
 * joint positions (the Fourier-component "bones"), draws a smooth, shaded
 * human-arm-like silhouette that deforms continuously as the joints move —
 * shoulder -> upper arm -> forearm -> hand (with thumb) -> finger phalanges
 * -> fingertip, with any additional bones drawn as tapering tentacle-like
 * continuations. Pure Canvas 2D vector paths; no images.
 *
 * All pieces (shoulder cap, main limb tube, thumb) are built as `Path2D`
 * objects and rendered as a single opaque union: every outline is stroked
 * FIRST (at double the visible width), then every piece is filled solid
 * on top. Because the fill exactly covers the inner half of its own stroke,
 * only the half that isn't covered by *some* piece's fill survives — i.e.
 * the outline of the boolean union, with no seams where pieces overlap.
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
const MIN_HALF_PX = 8; // floor on every drawn half-width, in the same px space as joint handles

// Per-bone-type half-width profiles: [u, fraction] control points, u in [0,1]
// along the bone from its proximal (near-body) end to its distal (far) end.
// Values are fractions of that bone's widthScale (see boneWidthScale()).
// Base half-width, as a fraction of the bone's OWN length, at each bone
// type's widest profile point (fraction 1.0). Hands are proportionally
// short-and-wide; limbs and fingers are proportionally long-and-narrow.
const PROPORTIONS = {
  upperArm: 0.3,
  forearm: 0.27,
  hand: 0.62,
  phalanx1: 0.36,
  phalanx2: 0.34,
  tentacle: 0.3,
};

// Fraction of the whole-chain average bone length ("unit") below which a
// bone's effective length is floored when sizing its width. Hands/fingers
// are often much shorter than the upper arm/forearm; without a generous
// floor they'd read as thin stubs instead of a hand + fingers.
const LENGTH_FLOOR = {
  upperArm: 0.15,
  forearm: 0.15,
  hand: 0.35,
  phalanx1: 0.3,
  phalanx2: 0.3,
  tentacle: 0.2,
};

const PROFILES = {
  upperArm: [
    [0, 1.0],
    [0.1, 0.85],
    [0.45, 0.78],
    [0.8, 0.55],
    [1, 0.42],
  ],
  forearm: [
    [0, 0.8],
    [0.3, 0.62],
    [1, 0.32],
  ],
  // Palm wider than the wrist: narrower at u=0 (wrist), widest across the
  // palm, tapering slightly toward the knuckles (u=1) where fingers attach.
  hand: [
    [0, 0.42],
    [0.32, 0.88],
    [0.68, 0.82],
    [1, 0.58],
  ],
  phalanx1: [
    [0, 0.46],
    [1, 0.38],
  ],
  // Plumper, rounded fingertip (wide enough to read as a tip + nail, and to
  // fully contain the fingertip's draggable joint handle).
  phalanx2: [
    [0, 0.4],
    [0.7, 0.34],
    [1, 0.26],
  ],
  tentacle: [
    [0, 0.32],
    [1, 0.22],
  ],
};

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

function boneTypeFor(i) {
  if (i === 0) return 'upperArm';
  if (i === 1) return 'forearm';
  if (i === 2) return 'hand';
  if (i === 3) return 'phalanx1';
  if (i === 4) return 'phalanx2';
  return 'tentacle';
}

/**
 * Build per-bone geometry (endpoints, direction, normal, length, width
 * profile) from raw joint pixel positions, guarding zero-length bones.
 */
function buildBoneGeom(jointsPx, unit) {
  const n = jointsPx.length - 1;
  const bones = [];
  let prevDir = { x: 1, y: 0 };
  for (let i = 0; i < n; i++) {
    const p0 = jointsPx[i];
    const p1 = jointsPx[i + 1];
    const raw = sub(p1, p0);
    const length = vlen(raw);
    const dir = length > 1e-6 ? { x: raw.x / length, y: raw.y / length } : prevDir;
    prevDir = dir;
    const nrm = normalOf(dir);
    const type = boneTypeFor(i);
    // Width tracks this bone's OWN length (so short finger segments read as
    // narrow, not as fat as the upper arm) — but with a per-type floor tied
    // to the whole chain's average bone length, so a hand/finger that's
    // genuinely much shorter than the limbs (a common Fourier-preset shape)
    // still reads as a hand and fingers instead of a stub.
    const floorFrac = LENGTH_FLOOR[type] ?? 0.15;
    const effectiveLen = clamp(length, unit * floorFrac, unit * 2.2);
    let widthScale = effectiveLen * PROPORTIONS[type];
    if (i >= 5) widthScale *= Math.pow(0.82, i - 4);
    bones.push({ p0, p1, dir, nrm, length, type, profile: PROFILES[type], widthScale });
  }
  return bones;
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

  let totalLen = 0;
  for (let i = 0; i < n; i++) totalLen += vlen(sub(jointsPx[i + 1], jointsPx[i]));
  let unit = n > 0 ? totalLen / n : 0;
  if (!(unit > 1e-6)) unit = opts.scalePx ? opts.scalePx * 0.5 : 40;
  unit = clamp(unit, 8, 400);

  const MIN_HALF = Math.max(1.5, unit * 0.05, MIN_HALF_PX);
  const MAX_HALF = Math.max(unit * 1.1, MIN_HALF);

  const bones = buildBoneGeom(jointsPx, unit);

  // Per-joint bisector normals and blended widths (j = 0..n), plus a
  // "foldedness" factor (0 = straight, 1 = folded back on itself) used to
  // soften the visual join at extreme flexion (skin only; kinematics untouched).
  const jointNormal = new Array(n + 1);
  const jointWidth = new Array(n + 1);
  const jointFold = new Array(n + 1).fill(0);
  jointNormal[0] = bones[0].nrm;
  jointWidth[0] = clamp(bones[0].widthScale * profileAt(bones[0].profile, 0), MIN_HALF, MAX_HALF);
  jointNormal[n] = bones[n - 1].nrm;
  jointWidth[n] = clamp(bones[n - 1].widthScale * profileAt(bones[n - 1].profile, 1), MIN_HALF, MAX_HALF);
  for (let j = 1; j < n; j++) {
    const sum = add(bones[j - 1].nrm, bones[j].nrm);
    jointNormal[j] = safeNorm(sum, bones[j - 1].nrm);
    const wPrevEnd = bones[j - 1].widthScale * profileAt(bones[j - 1].profile, 1);
    const wNextStart = bones[j].widthScale * profileAt(bones[j].profile, 0);
    jointWidth[j] = clamp((wPrevEnd + wNextStart) / 2, MIN_HALF, MAX_HALF);
    const cosAngle = clamp(dot(bones[j - 1].dir, bones[j].dir), -1, 1);
    jointFold[j] = clamp((1 - cosAngle) / 2, 0, 1); // 0 straight, 1 folded back
  }

  // Sample left/right offset points along the whole chain.
  const leftPts = [];
  const rightPts = [];
  for (let i = 0; i < n; i++) {
    const g = bones[i];
    const startS = i === 0 ? 0 : 1;
    for (let s = startS; s <= SAMPLES_PER_BONE; s++) {
      const u = s / SAMPLES_PER_BONE;
      const a0 = u < BLEND ? 1 - smoothstep(u / BLEND) : 0;
      const a1 = u > 1 - BLEND ? smoothstep((u - (1 - BLEND)) / BLEND) : 0;
      const aOwn = 1 - a0 - a1;
      let nrm = {
        x: g.nrm.x * aOwn + jointNormal[i].x * a0 + jointNormal[i + 1].x * a1,
        y: g.nrm.y * aOwn + jointNormal[i].y * a0 + jointNormal[i + 1].y * a1,
      };
      nrm = safeNorm(nrm, g.nrm);
      const ownWidth = g.widthScale * profileAt(g.profile, u);
      const width = clamp(ownWidth * aOwn + jointWidth[i] * a0 + jointWidth[i + 1] * a1, MIN_HALF, MAX_HALF);
      const point = lerp(g.p0, g.p1, u);
      leftPts.push(add(point, scale(nrm, width)));
      rightPts.push(add(point, scale(nrm, -width)));
    }
  }

  const tipPoint = bones[n - 1].p1;
  const tipNormal = jointNormal[n];
  const tipDir = bones[n - 1].dir;
  const tipWidth = jointWidth[n];
  const shoulderPoint = bones[0].p0;
  const shoulderNormal = jointNormal[0];
  const shoulderWidth = jointWidth[0];

  const backDir = { x: -bones[0].dir.x, y: -bones[0].dir.y };
  const backNormal = { x: -shoulderNormal.x, y: -shoulderNormal.y };
  const rightRev = rightPts.slice().reverse();

  // -- Build every piece as a Path2D (so the exact same geometry is used for
  // both the stroke pass and the fill pass — no seam mismatch). -----------

  const tubePath = new Path2D();
  tubePath.moveTo(leftPts[0].x, leftPts[0].y);
  curveThrough(tubePath, leftPts.slice(1));
  drawRoundCap(tubePath, tipPoint, tipNormal, tipDir, tipWidth);
  curveThrough(tubePath, rightRev);
  drawRoundCap(tubePath, shoulderPoint, backNormal, backDir, shoulderWidth);
  tubePath.closePath();

  // Shoulder / torso cap: a rounded deltoid stub the upper-arm tube plugs into.
  const stubCenter = add(shoulderPoint, scale(bones[0].dir, -shoulderWidth * 0.9));
  const stubAngle = Math.atan2(bones[0].dir.y, bones[0].dir.x);
  const stubPath = new Path2D();
  stubPath.ellipse(stubCenter.x, stubCenter.y, shoulderWidth * 1.15, shoulderWidth * 1.5, stubAngle + Math.PI / 2, 0, Math.PI * 2);

  // Joint discs: fill over the tube's own seams/pinches at each interior
  // joint. Radius grows with foldedness so a >150° elbow/knuckle fold is
  // visually smoothed instead of showing a self-intersecting notch.
  const jointCapPaths = [];
  for (let j = 1; j < n; j++) {
    const p = jointsPx[j];
    const r = jointWidth[j] * (1.05 + jointFold[j] * 1.1);
    const jp = new Path2D();
    jp.arc(p.x, p.y, r, 0, Math.PI * 2);
    jointCapPaths.push(jp);
  }

  // Thumb: rigid child of the hand bone (index 2), angled off to one side.
  let thumbPath = null;
  let thumbKnucklePath = null;
  let thumbBase = null;
  let thumbBaseW = 0;
  if (n >= 3) {
    const hand = bones[2];
    thumbBase = lerp(hand.p0, hand.p1, 0.22);
    const thumbAngle = -1.0; // fixed offset relative to hand bone orientation
    const thumbDir = rotate(hand.dir, thumbAngle);
    const thumbLen = hand.length * 0.55;
    const thumbTip = add(thumbBase, scale(thumbDir, thumbLen));
    const thumbNormal = normalOf(thumbDir);
    const thumbProfile = PROFILES.phalanx1;
    const thumbWidthScale = hand.widthScale * 0.85;
    const tLeft = [];
    const tRight = [];
    for (let s = 0; s <= SAMPLES_PER_BONE; s++) {
      const u = s / SAMPLES_PER_BONE;
      const w = clamp(thumbWidthScale * profileAt(thumbProfile, u), MIN_HALF * 0.85, MAX_HALF);
      const pt = lerp(thumbBase, thumbTip, u);
      tLeft.push(add(pt, scale(thumbNormal, w)));
      tRight.push(add(pt, scale(thumbNormal, -w)));
    }
    thumbBaseW = clamp(thumbWidthScale * profileAt(thumbProfile, 0), MIN_HALF * 0.85, MAX_HALF);
    const thumbTipW = clamp(thumbWidthScale * profileAt(thumbProfile, 1), MIN_HALF * 0.85, MAX_HALF);
    thumbKnucklePath = new Path2D();
    thumbKnucklePath.arc(thumbBase.x, thumbBase.y, thumbBaseW * 1.15, 0, Math.PI * 2);
    thumbPath = new Path2D();
    thumbPath.moveTo(tLeft[0].x, tLeft[0].y);
    curveThrough(thumbPath, tLeft.slice(1));
    drawRoundCap(thumbPath, thumbTip, thumbNormal, thumbDir, thumbTipW);
    curveThrough(thumbPath, tRight.slice().reverse());
    thumbPath.closePath();
  }

  // The skin itself is always drawn fully opaque (that's the whole point of
  // the union-outline trick above — no seams). `xray` only controls whether
  // the thin bone struts are drawn translucently on TOP of it, afterward.
  ctx.save();
  ctx.lineJoin = 'round';

  // -- Pass 1: stroke every outline FIRST, at double the visible width. ----
  // The fill pass (below) covers the inner half of each stroke; only the
  // half not covered by any piece's fill survives, which is exactly the
  // outline of the boolean union — no seams where pieces overlap.
  const outlineW = Math.max(1, unit * 0.04);
  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = outlineW * 2;
  ctx.stroke(stubPath);
  ctx.stroke(tubePath);
  if (thumbPath) ctx.stroke(thumbPath);

  // -- Pass 2: fill every piece solid, opaque, on top. ---------------------
  ctx.fillStyle = colors.skin;
  ctx.fill(stubPath, 'nonzero');
  ctx.fill(tubePath, 'nonzero');
  for (const jp of jointCapPaths) ctx.fill(jp);
  if (thumbKnucklePath) ctx.fill(thumbKnucklePath);
  if (thumbPath) ctx.fill(thumbPath);

  // -- Decorative overlays, drawn on top of the finished opaque union. -----

  // Subtle one-sided shading along the "right" (far) side.
  ctx.beginPath();
  ctx.moveTo(rightPts[0].x, rightPts[0].y);
  curveThrough(ctx, rightPts.slice(1));
  ctx.strokeStyle = colors.skinShade;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(1, unit * 0.06);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Small crease line on the flexion side of each joint.
  for (let j = 1; j < n; j++) {
    const p = jointsPx[j];
    const r = jointWidth[j] * (1.05 + jointFold[j] * 1.1);
    const cross = bones[j - 1].dir.x * bones[j].dir.y - bones[j - 1].dir.y * bones[j].dir.x;
    const side = cross >= 0 ? -1 : 1;
    const creaseCenter = add(p, scale(jointNormal[j], r * 0.55 * side));
    const creaseAngle = Math.atan2(jointNormal[j].y, jointNormal[j].x);
    ctx.beginPath();
    ctx.arc(creaseCenter.x, creaseCenter.y, r * 0.4, creaseAngle - 0.9, creaseAngle + 0.9);
    ctx.strokeStyle = colors.skinShade;
    ctx.lineWidth = Math.max(1, unit * 0.025);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Fingernail on the very last (tip) segment.
  if (n >= 1) {
    const lastBone = bones[n - 1];
    const nailCenter = add(lerp(lastBone.p0, lastBone.p1, 0.78), scale(tipNormal, tipWidth * 0.32));
    const nailR = Math.max(1.5, tipWidth * 0.42);
    ctx.beginPath();
    ctx.ellipse(nailCenter.x, nailCenter.y, nailR * 0.85, nailR * 0.55, Math.atan2(lastBone.dir.y, lastBone.dir.x), 0, Math.PI * 2);
    ctx.strokeStyle = colors.outline;
    ctx.lineWidth = Math.max(0.75, unit * 0.02);
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
    ctx.lineWidth = Math.max(1, unit * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(jointsPx[i].x, jointsPx[i].y);
      ctx.lineTo(jointsPx[i + 1].x, jointsPx[i + 1].y);
    }
    ctx.stroke();
    for (let j = 0; j <= n; j++) {
      ctx.beginPath();
      ctx.arc(jointsPx[j].x, jointsPx[j].y, Math.max(2, unit * 0.06), 0, Math.PI * 2);
      ctx.fillStyle = colors.bone;
      ctx.fill();
    }
    ctx.restore();
  }

  // Selection highlight.
  if (Number.isInteger(opts.selectedIndex) && opts.selectedIndex >= 0 && opts.selectedIndex < n) {
    const g = bones[opts.selectedIndex];
    ctx.save();
    ctx.strokeStyle = '#ffcc33';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(1.5, unit * 0.05);
    ctx.setLineDash([unit * 0.12, unit * 0.08]);
    ctx.beginPath();
    ctx.moveTo(g.p0.x, g.p0.y);
    ctx.lineTo(g.p1.x, g.p1.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [g.p0, g.p1]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, unit * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc33';
      ctx.fill();
    }
    ctx.restore();
  }
}
