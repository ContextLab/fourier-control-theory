/**
 * Stylized vector "metallic shell" rendering for the robot-arm puppet. Given
 * pixel-space joint positions for the 3-bone main chain (shoulder -> elbow ->
 * wrist -> palm) and, separately, the 5 real finger chains (each 3 joints,
 * from core/gesture.js's forward kinematics), draws a smooth, shaded
 * robotic-arm-and-hand silhouette that deforms continuously as the joints
 * move. Pure Canvas 2D vector paths; no images.
 *
 * Anatomical proportions (upper arm, forearm, palm, finger widths) are all
 * derived from a single global scale — `armScale`, the pixel length of the
 * upper-arm + forearm bones — rather than each bone's own length. This is
 * what keeps the hand and fingers slender and readable even though their
 * *own* lengths (and, in gesture mode, their own independent rotation) are
 * small and change continuously.
 *
 * All pieces (limb tube, palm, 5 real fingers) are built as `Path2D` objects
 * and rendered as a single opaque union: every outline is stroked FIRST (at
 * double the visible width), then every piece is filled solid on top.
 * Because the fill exactly covers the inner half of its own stroke, only the
 * half that isn't covered by *some* piece's fill survives — i.e. the
 * outline of the boolean union, with no seams where pieces overlap.
 *
 * The "skin" itself is a brushed-steel gradient (dark -> light -> dark, one
 * shared CanvasGradient reused for every fill) with a thin specular
 * highlight stroke along each tube and small rivet-like joint caps, giving a
 * robotic-shell look rather than an organic one.
 * @module ui/armSkin
 */

const DEFAULT_COLORS = {
  skin: '#9aa3ad',
  skinShade: '#5b636c',
  skinHighlight: '#e7ebef',
  outline: '#2b3138',
  bone: '#8a6996',
};

const SAMPLES_PER_BONE = 8;
const BLEND = 0.22; // fraction of each bone's own parameter range blended toward the joint value
const MIN_HALF_PX = 8; // absolute floor on every drawn half-width, in the same px space as joint handles (radius <= 7px)

// -- Anatomical taper tables, all expressed as a FRACTION OF `armScale` (the
// combined pixel length of the upper-arm + forearm bones). [u, fraction]
// control points, u in [0,1] along the piece from its proximal to distal end.

const LIMB_PROFILES = {
  upperArm: [
    [0, 0.16],
    [0.15, 0.148],
    [0.5, 0.125],
    [0.85, 0.1],
    [1, 0.09],
  ],
  forearm: [
    [0, 0.09],
    [0.25, 0.085],
    [0.6, 0.07],
    [1, 0.048],
  ],
};

// Palm: a clearly visible plate, distinctly wider across the knuckles than
// at the wrist — wide enough to comfortably contain all 5 fingers'
// attachment points (see core/gesture.js's FINGER_SPEC lateral offsets)
// inside its own edge, so the fingers read as rooted ON the plate rather
// than floating past it.
const PALM_PROFILE = [
  [0, 0.07],
  [0.4, 0.1],
  [1, 0.115],
];

// Finger phalanges: narrow and only mildly tapered. Thumb gets its own,
// slightly stouter profile.
const FINGER_PROFILES = {
  phalanx1: [[0, 0.034], [1, 0.028]],
  phalanx2: [[0, 0.027], [1, 0.021]],
  phalanx3: [[0, 0.02], [1, 0.014]],
};
const THUMB_PROFILES = {
  phalanx1: [[0, 0.04], [1, 0.032]],
  phalanx2: [[0, 0.03], [1, 0.023]],
  phalanx3: [[0, 0.022], [1, 0.015]],
};

// -- small vector helpers -----------------------------------------------

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(a, sc) {
  return { x: a.x * sc, y: a.y * sc };
}
function lerp(a, b, u) {
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}
function vlen(a) {
  return Math.hypot(a.x, a.y);
}
function safeNorm(a, fallback) {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : fallback;
}
function normalOf(dir) {
  return { x: -dir.y, y: dir.x };
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
 * Build a tapered tube through an explicit chain of points.
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
    for (let sIdx = startS; sIdx <= SAMPLES_PER_BONE; sIdx++) {
      const u = sIdx / SAMPLES_PER_BONE;
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

/** Per-bone unit directions through a chain of points, guarding zero-length segments. */
function dirsThrough(points) {
  const dirs = [];
  let prevDir = { x: 1, y: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const raw = sub(points[i + 1], points[i]);
    const len = vlen(raw);
    const d = len > 1e-6 ? { x: raw.x / len, y: raw.y / len } : prevDir;
    prevDir = d;
    dirs.push(d);
  }
  return dirs;
}

/**
 * `true` iff every component carries a `label` string — i.e. this is one of
 * the anatomical human-arm chains (as opposed to an arbitrary Fourier chain),
 * the only case in which the skin should be drawn.
 * @param {Array<object>} components
 * @returns {boolean}
 */
export function isAnatomical(components) {
  return Array.isArray(components) && components.length > 0
    && components.every((c) => c && typeof c.label === 'string');
}

const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'little'];

/**
 * Draw a stylized metallic-shell skin over the 3-bone main chain plus 5 real
 * finger chains.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}[]} mainJointsPx - [shoulder, elbow, wrist, palmTip], px
 * @param {Object<string, {x:number,y:number}[]>} fingerJointsPx - per finger
 *   name, [base, j1, j2, j3] px (4 points = 3 phalanx segments) OR
 *   [base, j1, j2] px (3 points = 2 segments, spin mode's index-driven
 *   overlay); any missing finger is simply skipped. Each finger is always
 *   built as its own separate Path2D piece — never merged with another
 *   finger — so gaps between them stay visible even where their strokes
 *   nearly touch.
 * @param {{scalePx?:number, colors?:object, xray?:boolean, selectedIndex?:number,
 *   parts?: 'all'|'main'|'fingers'}} [opts] - `parts` (default 'all') draws
 *   only the main chain (arm+palm) or only the 5 fingers, so a caller can
 *   sandwich something (e.g. the pick-up-ball's ball) between the two: draw
 *   'main', draw the object, draw 'fingers' on top of it, so a closed hand's
 *   fingers visibly wrap around it instead of hiding it entirely. Selection/
 *   hover handles for individual joints (main or finger) are drawn by the
 *   caller (armView.js), not here.
 */
export function drawArmSkin(ctx, mainJointsPx, fingerJointsPx = {}, opts = {}) {
  if (!Array.isArray(mainJointsPx) || mainJointsPx.length < 2 || mainJointsPx.some((p) => !isFinitePt(p))) {
    return;
  }
  const colors = { ...DEFAULT_COLORS, ...(opts.colors || {}) };
  const xray = !!opts.xray;
  const parts = opts.parts || 'all';
  const wantMain = parts !== 'fingers';
  const wantFingers = parts !== 'main';
  const n = mainJointsPx.length - 1; // number of main bones present (1..3)

  const dirs = dirsThrough(mainJointsPx);

  // Global scale: the upper-arm + forearm pixel length when both are present.
  let armScale;
  if (n >= 2) {
    armScale = vlen(sub(mainJointsPx[1], mainJointsPx[0])) + vlen(sub(mainJointsPx[2], mainJointsPx[1]));
  } else {
    armScale = vlen(sub(mainJointsPx[1], mainJointsPx[0])) * 2;
  }
  if (!(armScale > 1e-6)) armScale = opts.scalePx ? opts.scalePx * 0.8 : 80;
  armScale = clamp(armScale, 16, 1600);

  const MIN_HALF = Math.max(1.5, MIN_HALF_PX);
  const MAX_HALF = Math.max(armScale * 0.6, MIN_HALF);

  const pieces = []; // Path2D list: stroked (outline) then filled (opaque union)
  const capPieces = []; // small circular seam-blend / rivet caps, filled only
  const fingerHinges = []; // {p, r} metal hinge rings drawn at every finger joint

  const hasPalm = n >= 3;
  const limbCount = Math.min(n, 2);
  const limbDirs = dirs.slice(0, limbCount);

  // -- Upper arm (+ forearm): one continuous tapered tube ------------------
  let limbTube = null;
  if (wantMain) {
    const limbPoints = mainJointsPx.slice(0, limbCount + 1);
    const limbWidthAt = (seg, u) => {
      const profile = seg === 0 ? LIMB_PROFILES.upperArm : LIMB_PROFILES.forearm;
      return armScale * profileAt(profile, u);
    };
    limbTube = buildTube(limbPoints, limbDirs, limbWidthAt, MIN_HALF, MAX_HALF);
    const shoulderCap = {
      center: mainJointsPx[0],
      normal: limbTube.jointNormal[0],
      dir: { x: -limbDirs[0].x, y: -limbDirs[0].y },
      width: limbTube.jointWidth[0],
    };
    const limbTipCap = hasPalm
      ? null
      : { center: mainJointsPx[limbCount], normal: limbTube.jointNormal[limbCount], dir: limbDirs[limbCount - 1], width: limbTube.jointWidth[limbCount] };
    pieces.push(tubeToPath(limbTube, shoulderCap, limbTipCap));
    if (limbCount === 2) capPieces.push(circlePath(mainJointsPx[1], limbTube.jointWidth[1] * 1.05));
  }

  // -- Palm: a rounded trapezoid from the wrist to the knuckles ------------
  let palmTube = null;
  let handDir = hasPalm ? dirs[2] : null;
  if (wantMain && hasPalm) {
    const palmPoints = mainJointsPx.slice(2, 4);
    const palmWidthAt = (_seg, u) => armScale * profileAt(PALM_PROFILE, u);
    palmTube = buildTube(palmPoints, [handDir], palmWidthAt, MIN_HALF, MAX_HALF);
    const hasFingers = Object.keys(fingerJointsPx).length > 0;
    const knuckleCap = hasFingers ? null : { center: mainJointsPx[3], normal: palmTube.jointNormal[1], dir: handDir, width: palmTube.jointWidth[1] };
    pieces.push(tubeToPath(palmTube, null, knuckleCap));
    capPieces.push(circlePath(mainJointsPx[2], palmTube.jointWidth[0] * 1.05));
  }

  // -- Fingers: 5 real chains (thumb + 4 fingers), each a 3-segment tapered
  // tube through [base, j1, j2, j3]. Widths still come from `armScale`, not
  // from these (often small) bones' own length.
  if (wantFingers && hasPalm) {
    const segProfiles = (name) => (name === 'thumb' ? THUMB_PROFILES : FINGER_PROFILES);
    const profileForSeg = (name, seg, segCount) => {
      const profiles = segProfiles(name);
      // 2-segment fingers (spin mode's index-driven overlay) use the
      // proximal + distal profiles; 3-segment fingers use all three.
      if (segCount === 2) return seg === 0 ? profiles.phalanx1 : profiles.phalanx3;
      return seg === 0 ? profiles.phalanx1 : seg === 1 ? profiles.phalanx2 : profiles.phalanx3;
    };
    for (const name of FINGER_ORDER) {
      const pts = fingerJointsPx[name];
      if (!Array.isArray(pts) || (pts.length !== 3 && pts.length !== 4) || pts.some((p) => !isFinitePt(p))) continue;
      const segCount = pts.length - 1;
      const fDirs = dirsThrough(pts);
      const widthAt = (seg, u) => armScale * profileAt(profileForSeg(name, seg, segCount), u);
      // Each finger is its own independent tube/Path2D — added as a separate
      // entry in `pieces`, never merged with another finger's points — so
      // it always keeps its own outline and a visible gap from its neighbors.
      const tube = buildTube(pts, fDirs, widthAt, MIN_HALF * 0.8, MAX_HALF);
      const tipIdx = segCount;
      const tipCap = { center: pts[tipIdx], normal: tube.jointNormal[tipIdx], dir: fDirs[segCount - 1], width: tube.jointWidth[tipIdx] };
      pieces.push(tubeToPath(tube, null, tipCap));
      for (let k = 0; k < pts.length - 1; k++) {
        capPieces.push(circlePath(pts[k], tube.jointWidth[k] * 1.05));
        fingerHinges.push({ p: pts[k], r: tube.jointWidth[k] });
      }
    }
  }

  // -- Metallic brushed-steel gradient, shared across every fill -----------
  // Direction: perpendicular to the overall limb direction, so the
  // highlight reads as a single consistent light source across the whole
  // arm+hand rather than per-piece (much cheaper and reads more like one
  // continuous metal shell). The gradient's extent is the full projected
  // span of EVERY point being drawn (main chain + all 5 fingers) onto that
  // axis, not just a small fixed radius near the elbow — otherwise a finger
  // far from that radius samples past the gradient's last stop and renders
  // as a flat, dark, disconnected-looking blob instead of matching the rest
  // of the shell.
  const overallDir = dirs[0] || { x: 1, y: 0 };
  const overallNormal = normalOf(overallDir);
  const gradOrigin = mainJointsPx[0];
  const allDrawnPts = [...mainJointsPx];
  for (const name of Object.keys(fingerJointsPx)) {
    const pts = fingerJointsPx[name];
    if (Array.isArray(pts)) for (const p of pts) if (isFinitePt(p)) allDrawnPts.push(p);
  }
  let minProj = 0;
  let maxProj = 0;
  for (const p of allDrawnPts) {
    const rel = sub(p, gradOrigin);
    const proj = rel.x * overallNormal.x + rel.y * overallNormal.y;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  const gradPad = Math.max(MAX_HALF * 0.4, (maxProj - minProj) * 0.12, 1);
  const gradA = add(gradOrigin, scale(overallNormal, minProj - gradPad));
  const gradB = add(gradOrigin, scale(overallNormal, maxProj + gradPad));
  const metalGrad = ctx.createLinearGradient(gradA.x, gradA.y, gradB.x, gradB.y);
  metalGrad.addColorStop(0, colors.skinShade);
  metalGrad.addColorStop(0.32, colors.skin);
  metalGrad.addColorStop(0.5, colors.skinHighlight);
  metalGrad.addColorStop(0.68, colors.skin);
  metalGrad.addColorStop(1, colors.skinShade);

  ctx.save();
  ctx.lineJoin = 'round';

  // -- Pass 1: stroke every outline FIRST, at double the visible width. ----
  const outlineW = Math.max(1, armScale * 0.02);
  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = outlineW * 2;
  for (const p of pieces) ctx.stroke(p);

  // -- Pass 2: fill every piece (and seam-blend/rivet cap) with the shared
  // metallic gradient, opaque, on top. ---------------------------------
  ctx.fillStyle = metalGrad;
  for (const cp of capPieces) ctx.fill(cp);
  for (const p of pieces) ctx.fill(p, 'nonzero');

  // -- Decorative overlays, drawn on top of the finished opaque union. -----

  if (limbTube) {
    // Specular highlight stripe along the "near" side of the limb + palm —
    // reads as a bright reflection running down a metal tube.
    ctx.beginPath();
    ctx.moveTo(limbTube.leftPts[0].x, limbTube.leftPts[0].y);
    curveThrough(ctx, limbTube.leftPts.slice(1));
    if (palmTube) curveThrough(ctx, palmTube.leftPts);
    ctx.strokeStyle = colors.skinHighlight;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = Math.max(1, armScale * 0.02);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Subtle shading along the far side.
    ctx.beginPath();
    ctx.moveTo(limbTube.rightPts[0].x, limbTube.rightPts[0].y);
    curveThrough(ctx, limbTube.rightPts.slice(1));
    if (palmTube) curveThrough(ctx, palmTube.rightPts);
    ctx.strokeStyle = colors.skinShade;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = Math.max(1, armScale * 0.025);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Panel-seam rings (rivets/hinges) at the elbow, wrist, and every finger
  // joint — a small metal ring + bright center dot, so every joint reads as
  // a mechanical hinge even before any colored drag-handle is drawn on top.
  const seamJoints = [];
  if (limbTube && limbCount === 2) seamJoints.push({ p: mainJointsPx[1], r: limbTube.jointWidth[1] });
  if (palmTube) seamJoints.push({ p: mainJointsPx[2], r: palmTube.jointWidth[0] });
  for (const h of fingerHinges) seamJoints.push(h);
  for (const { p, r } of seamJoints) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2, r * 0.62), 0, Math.PI * 2);
    ctx.strokeStyle = colors.outline;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, armScale * 0.012);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.2, r * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = colors.skinHighlight;
    ctx.globalAlpha = 0.6;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // X-ray: show the underlying main-chain bone struts, thin and
  // translucent, on top of the now fully-opaque skin.
  if (xray) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = colors.bone;
    ctx.lineWidth = Math.max(1, armScale * 0.014);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(mainJointsPx[i].x, mainJointsPx[i].y);
      ctx.lineTo(mainJointsPx[i + 1].x, mainJointsPx[i + 1].y);
    }
    ctx.stroke();
    for (let j = 0; j <= n; j++) {
      ctx.beginPath();
      ctx.arc(mainJointsPx[j].x, mainJointsPx[j].y, Math.max(2, armScale * 0.017), 0, Math.PI * 2);
      ctx.fillStyle = colors.bone;
      ctx.fill();
    }
    ctx.restore();
  }

  // Selection highlight (main-chain bone).
  if (Number.isInteger(opts.selectedIndex) && opts.selectedIndex >= 0 && opts.selectedIndex < n) {
    const p0 = mainJointsPx[opts.selectedIndex];
    const p1 = mainJointsPx[opts.selectedIndex + 1];
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
