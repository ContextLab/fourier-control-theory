// Robot-arm / epicycle view: chain of links (Fourier components) in spin mode,
// or the articulated arm+hand tree in gesture mode; joint dragging,
// end-effector trace + fading trail; the pick-up-a-ball table + ball.
import { setupCanvas, makeTransform, cssVar } from './canvas.js';
import { jointPositions, invertDrag, jointAngles } from '../core/arm.js';
import { drawArmSkin, isAnatomical } from './armSkin.js';
import { MAX_AMP } from '../core/store.js';
import {
  forwardKinematics, evalSeries, FINGER_NAMES, FINGER_GEOMETRY, MAIN_JOINT_IDS, pickupBallState, PICKUP,
} from '../core/gesture.js';

const HIT_RADIUS = 12; // px, joint-tip hit test
const TRAIL_MAX = 90; // recent-tip trail length (frames)
const FIT_MARGIN = 0.08; // fraction of each side reserved as margin around the fitted bbox
const SCALE_EASE = 0.12; // per-render lerp factor for autofit scale/center (frozen while dragging)
const TIME_JUMP_THRESHOLD = 0.05; // fraction of a period; a bigger circular jump resets the trail
const THEME_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Spin mode's hand overlay: the 5 components stay exactly upper arm, forearm,
 * palm, "Finger", "Fingertip" (unchanged Fourier chain, still fully
 * draggable as thin bone struts) — the INDEX finger reuses components 3 and
 * 4's own live relative angles for its two segments, and the other four
 * fingers "follow the index finger's curl" by applying that SAME pair of
 * relative angles at their own anatomical base point, so all five render as
 * separate, independently-outlined 2-segment fingers rooted on the palm.
 * @param {Array<object>} components
 * @param {number} t
 * @param {{re:number,im:number}[]} pts - jointPositions(components, t) (length 6)
 * @returns {Object<string, {re:number,im:number}[]>} per finger, [base, j1, j2]
 */
function spinHandFingerPoints(components, t, pts) {
  if (components.length < 5) return {};
  const { abs } = jointAngles(components, t);
  const relFinger = abs[3] - abs[2];
  const relTip = abs[4] - abs[3];
  const handAbsAngle = abs[2];
  const palmTip = pts[3];
  const d = { re: Math.cos(handAbsAngle), im: Math.sin(handAbsAngle) };
  const p = { re: -Math.sin(handAbsAngle), im: Math.cos(handAbsAngle) };
  const out = {};
  for (const f of FINGER_GEOMETRY) {
    const base = {
      re: palmTip.re + f.forward * d.re + f.lateral * p.re,
      im: palmTip.im + f.forward * d.im + f.lateral * p.im,
    };
    const a1 = handAbsAngle + f.spread + relFinger;
    const j1 = { re: base.re + f.lengths[0] * Math.cos(a1), im: base.im + f.lengths[0] * Math.sin(a1) };
    const a2 = a1 + relTip;
    const seg2Len = f.lengths[1] + f.lengths[2];
    const j2 = { re: j1.re + seg2Len * Math.cos(a2), im: j1.im + seg2Len * Math.sin(a2) };
    out[f.name] = [base, j1, j2];
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../core/store.js').createStore>} store
 * @param {{interactive?: boolean, showTrace?: boolean, showCircles?: boolean,
 *          numberJoints?: boolean, componentsOverride?: () => Array<object>,
 *          gestureOverride?: () => Array<object>, skin?: boolean}} [opts] -
 *          `componentsOverride` overrides spin-mode components (e.g. the
 *          Control tab's band-limited reconstruction); `gestureOverride`
 *          does the same for gesture mode's bone tree. `skin` (else
 *          `state.showSkin`) renders the metallic-shell arm+hand
 *          (armSkin.js) with bones drawn thin/translucent on top.
 */
export function createArmView(canvas, store, opts = {}) {
  let lastJointsCss = [];
  let lastGestureJointsCss = new Map(); // id -> {x, y}
  const {
    interactive = true,
    showTrace = true,
    numberJoints = false,
    componentsOverride = null,
    gestureOverride = null,
  } = opts;

  const cv = setupCanvas(canvas);
  // 'none' would block page scrolling on touch entirely. Allow vertical pan +
  // pinch-zoom by default; onTouchStart below cancels that per-gesture (via
  // preventDefault, since touch-action can't change mid-gesture) only when
  // the touch actually starts on a joint, so joint-dragging still works.
  if (interactive) canvas.style.touchAction = 'pan-y pinch-zoom';
  if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'img');
  if (!canvas.hasAttribute('aria-label')) {
    canvas.setAttribute('aria-label', 'Animated robot-arm / Fourier-epicycle diagram');
  }

  let colors = readColors();
  function readColors() {
    return {
      bg: cssVar('--bg-color', '#0f172a'),
      surface: cssVar('--surface-color', '#1e293b'),
      textSecondary: cssVar('--text-secondary', '#94a3b8'),
      border: cssVar('--border-color', '#334155'),
      primary: cssVar('--primary-color', '#00693e'),
      accent: cssVar('--accent-color', '#ffa00f'),
      skin: cssVar('--skin', '#9aa3ad'),
      skinShade: cssVar('--skin-shade', '#5b636c'),
      skinHighlight: cssVar('--skin-highlight', '#e7ebef'),
      skinOutline: cssVar('--skin-outline', '#2b3138'),
      tableColor: cssVar('--table-color', '#7a5a3a'),
      ballColor: cssVar('--ball-color', '#d94415'),
    };
  }
  const onThemeChange = () => { colors = readColors(); };
  document.addEventListener('themechange', onThemeChange);

  let currentScale = 1;
  let currentCenter = { re: 0, im: 0 };
  let viewInitialized = false;
  const trail = []; // { re, im } most-recent-last
  let lastT = null;

  // Drag state. In spin mode: { pointerId, k, id } (k = component index).
  // In gesture mode: { pointerId, boneId, parentId }.
  let dragging = null;
  let hoverK = -1; // spin mode hover (component index)
  let hoverBoneId = null; // gesture mode hover
  let lastPointerLocal = null; // { x, y } in canvas-center-relative local coords, for re-hit-testing on render

  function currentComponents(state) {
    return componentsOverride ? componentsOverride() : state.components;
  }

  function currentBones(state) {
    if (gestureOverride) return gestureOverride();
    return state.gesture && state.gesture.bones;
  }

  function isGestureMode(state) {
    return state.motion === 'gesture' && !!currentBones(state);
  }

  function showCirclesFor(state) {
    if (opts.showCircles !== undefined) return opts.showCircles;
    return !!state.showCircles;
  }

  function skinModeFor(state, components) {
    return !!(opts.skin ?? state.showSkin) && isAnatomical(components);
  }

  function resetTrail() {
    trail.length = 0;
  }

  // Track the source of the most recent components/gesture change, so
  // autofit can tell "the user is manipulating the arm" (source 'arm': a
  // joint drag) apart from "the shape changed underneath them" (preset load,
  // editor edit, drawing, a spectrum-stem drag). Also resets the fading
  // trail whenever the change came from outside this view.
  let lastComponentsSource = null;
  const unsubscribeComponents = store.subscribe((state, changedKeys, source) => {
    lastComponentsSource = source;
    if (source !== 'arm') resetTrail();
  }, ['components', 'gesture']);

  // -- Gesture-mode FK helpers ---------------------------------------------

  /** Main-chain world points [origin, upperArmTip, forearmTip, palmTip] + the FK map. */
  function gestureMainPoints(bones, t) {
    const fk = forwardKinematics(bones, t);
    const pts = [{ re: 0, im: 0 }];
    for (const id of MAIN_JOINT_IDS) pts.push(fk.get(id).tip);
    return { pts, fk };
  }

  /** Per-finger world points {name: [base, j1, j2, j3]} from an FK map. */
  function fingerWorldPoints(fk) {
    const out = {};
    for (const name of FINGER_NAMES) {
      const b1 = fk.get(`${name}1`);
      const b2 = fk.get(`${name}2`);
      const b3 = fk.get(`${name}3`);
      if (!b1 || !b2 || !b3) continue;
      out[name] = [b1.base, b1.tip, b2.tip, b3.tip];
    }
    return out;
  }

  /** All 18 joints as a flat [{id, tip, parentId}] list, for hit-testing/drag. */
  function allJointsFlat(bones, fk) {
    return bones.map((b) => ({ id: b.id, tip: fk.get(b.id).tip, parentAbsAngle: fk.get(b.id).absAngle - fk.get(b.id).relAngle }));
  }

  /**
   * Bounding box (world units) of the union of the full-period path and the
   * current arm pose, always including the origin (base/shoulder).
   */
  function computeBBox(components, state, derived) {
    let minRe = Infinity;
    let maxRe = -Infinity;
    let minIm = Infinity;
    let maxIm = -Infinity;
    const extend = (re, im) => {
      if (!Number.isFinite(re) || !Number.isFinite(im)) return;
      if (re < minRe) minRe = re;
      if (re > maxRe) maxRe = re;
      if (im < minIm) minIm = im;
      if (im > maxIm) maxIm = im;
    };
    extend(0, 0);
    const path = derived && derived.path;
    if (path && path.length >= 2) {
      for (let i = 0; i < path.length; i += 2) extend(path[i], path[i + 1]);
    }
    const pts = jointPositions(components, state.t, { re: 0, im: 0 });
    for (const p of pts) extend(p.re, p.im);

    let bboxW = Number.isFinite(minRe) ? maxRe - minRe : 0;
    let bboxH = Number.isFinite(minIm) ? maxIm - minIm : 0;
    const cx = Number.isFinite(minRe) ? (minRe + maxRe) / 2 : 0;
    const cy = Number.isFinite(minIm) ? (minIm + maxIm) / 2 : 0;
    if (!(bboxW > 1e-6) && !(bboxH > 1e-6)) {
      bboxW = 1;
      bboxH = 1;
    }
    return { minRe, maxRe, minIm, maxIm, cx, cy, bboxW, bboxH };
  }

  // Gesture mode's autofit is computed ONCE per bone-tree (fit to the
  // envelope of the WHOLE PERIOD, sampling FK at many t rather than just the
  // current frame's pose) and cached by bones-array identity, so playback
  // never re-targets the fit frame to frame — that was the "zoom pumping"
  // bug (the view chasing the current, constantly-moving pose) and also
  // what let the shoulder/upper-arm get cut off in wave (a single frame's
  // pose bbox doesn't necessarily cover the full swing). The cache is
  // invalidated only when the bones array itself changes identity — a new
  // preset, or (during/after a drag) updateJointMean's fresh array — so a
  // drag still eventually re-fits (eased in via updateAutofitGesture below),
  // just not on every unrelated animation frame.
  let envelopeCacheBones = null;
  let envelopeCache = null;

  function computeGestureEnvelope(bones, kind) {
    let minRe = Infinity;
    let maxRe = -Infinity;
    let minIm = Infinity;
    let maxIm = -Infinity;
    const extend = (re, im) => {
      if (!Number.isFinite(re) || !Number.isFinite(im)) return;
      if (re < minRe) minRe = re;
      if (re > maxRe) maxRe = re;
      if (im < minIm) minIm = im;
      if (im > maxIm) maxIm = im;
    };
    extend(0, 0);
    const ENVELOPE_SAMPLES = 64;
    for (let i = 0; i < ENVELOPE_SAMPLES; i += 1) {
      const t = i / ENVELOPE_SAMPLES;
      const fk = forwardKinematics(bones, t);
      for (const b of bones) {
        const j = fk.get(b.id);
        extend(j.tip.re, j.tip.im);
      }
      if (kind === 'pickup') {
        const ball = pickupBallState(bones, t);
        extend(ball.pos.re - PICKUP.ballRadius, ball.pos.im - PICKUP.ballRadius);
        extend(ball.pos.re + PICKUP.ballRadius, ball.pos.im + PICKUP.ballRadius);
      }
    }
    if (kind === 'pickup') {
      extend(PICKUP.ballRestX - PICKUP.tableHalfWidth, PICKUP.tableY - 0.05);
      extend(PICKUP.ballRestX + PICKUP.tableHalfWidth, PICKUP.tableY + 0.05);
    }
    let bboxW = Number.isFinite(minRe) ? maxRe - minRe : 0;
    let bboxH = Number.isFinite(minIm) ? maxIm - minIm : 0;
    const cx = Number.isFinite(minRe) ? (minRe + maxRe) / 2 : 0;
    const cy = Number.isFinite(minIm) ? (minIm + maxIm) / 2 : 0;
    if (!(bboxW > 1e-6) && !(bboxH > 1e-6)) {
      bboxW = 1;
      bboxH = 1;
    }
    const bbox = {
      minRe, maxRe, minIm, maxIm, cx, cy, bboxW, bboxH,
    };
    const totalReach = bones.reduce((s, b) => (MAIN_JOINT_IDS.includes(b.id) ? s + b.length : s), 0);
    return { bbox, totalReach };
  }

  function getGestureEnvelope(bones, kind) {
    if (envelopeCacheBones !== bones) {
      envelopeCache = computeGestureEnvelope(bones, kind);
      envelopeCacheBones = bones;
    }
    return envelopeCache;
  }

  // Every built-in preset normalizes its components' amplitudes to sum to 1
  // (see core/presets.js), so a component list's total reach (sum of |amp|)
  // is a stable proxy for "how big the arm itself is" regardless of how much
  // bigger the full swept path is. Flooring the scale relative to that reach
  // keeps a normal 5-bone arm (or similar) from shrinking to the point where
  // adjacent joints visually overlap, even when the path bbox is huge.
  const MIN_REACH_FRACTION = 0.32; // fraction of the canvas's smaller dimension

  /** Auto-fit target (scale + center) for a bbox, with an 8%-of-canvas margin. */
  function fitTargetFromBBox(bbox, totalReach) {
    const availW = Math.max(1, cv.w * (1 - 2 * FIT_MARGIN));
    const availH = Math.max(1, cv.h * (1 - 2 * FIT_MARGIN));
    let scale = Math.min(availW / Math.max(bbox.bboxW, 1e-6), availH / Math.max(bbox.bboxH, 1e-6));
    if (totalReach > 1e-6) {
      const minScale = (Math.min(cv.w, cv.h) * MIN_REACH_FRACTION) / totalReach;
      scale = Math.max(scale, minScale);
    }
    return { scale, center: { re: bbox.cx, im: bbox.cy } };
  }

  /**
   * `true` iff `bbox`, drawn with the CURRENT (not target) view, would spill
   * past the canvas edge (i.e. actually leave the visible canvas) — NOT
   * merely past the cosmetic margin.
   */
  function overflowsCanvas(bbox) {
    const tf = makeTransform(currentCenter, currentScale);
    const halfW = cv.w / 2;
    const halfH = cv.h / 2;
    const corners = [
      { re: bbox.minRe, im: bbox.minIm },
      { re: bbox.minRe, im: bbox.maxIm },
      { re: bbox.maxRe, im: bbox.minIm },
      { re: bbox.maxRe, im: bbox.maxIm },
    ];
    for (const c of corners) {
      const p = tf.toPx(c);
      if (Math.abs(p.x) > halfW || Math.abs(p.y) > halfH) return true;
    }
    return false;
  }

  // Set right when a drag ends (onPointerUp), consumed on the very next
  // render: if that release left the arm/path actually overflowing the
  // canvas, snap the autofit to its target immediately instead of easing.
  let justReleased = false;

  function updateAutofit(bbox, totalReach) {
    if (!viewInitialized) {
      const target = fitTargetFromBBox(bbox, totalReach);
      currentScale = target.scale;
      currentCenter = target.center;
      viewInitialized = true;
      return;
    }
    if (dragging) return;
    const overflowed = overflowsCanvas(bbox);
    const shouldRefit = lastComponentsSource !== 'arm' || overflowed;
    if (shouldRefit) {
      const target = fitTargetFromBBox(bbox, totalReach);
      const ease = (justReleased && overflowed) ? 1 : SCALE_EASE;
      currentScale += (target.scale - currentScale) * ease;
      currentCenter = {
        re: currentCenter.re + (target.center.re - currentCenter.re) * ease,
        im: currentCenter.im + (target.center.im - currentCenter.im) * ease,
      };
    }
    justReleased = false;
  }

  /**
   * Gesture mode's autofit: `bbox` is the whole-period ENVELOPE (see
   * getGestureEnvelope), not the current frame's pose, so it is already
   * stable frame to frame during ordinary playback — no per-frame re-target
   * is needed, just a simple ease toward it (frozen while dragging, snapped
   * once on first render).
   */
  function updateAutofitGesture(bbox, totalReach) {
    if (!viewInitialized) {
      const target = fitTargetFromBBox(bbox, totalReach);
      currentScale = target.scale;
      currentCenter = target.center;
      viewInitialized = true;
      return;
    }
    if (dragging) return;
    const target = fitTargetFromBBox(bbox, totalReach);
    const ease = justReleased ? 1 : SCALE_EASE;
    currentScale += (target.scale - currentScale) * ease;
    currentCenter = {
      re: currentCenter.re + (target.center.re - currentCenter.re) * ease,
      im: currentCenter.im + (target.center.im - currentCenter.im) * ease,
    };
    justReleased = false;
  }

  function drawJointDot(ctx, tf, p, { fillColor, selected, hovered, label }) {
    const px = tf.toPx(p);
    if (selected) {
      ctx.beginPath();
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = 0.25;
      ctx.arc(px.x, px.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = 1.5;
    ctx.arc(px.x, px.y, hovered ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (label) {
      ctx.fillStyle = colors.textSecondary;
      ctx.font = `11px ${THEME_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(label, px.x, px.y - 10);
    }
  }

  /** Draw the pick-up-a-ball table line, in world coords. Drawn BEHIND the arm/hand. */
  function drawTable(ctx, tf) {
    const y = PICKUP.tableY;
    const a = tf.toPx({ re: PICKUP.ballRestX - PICKUP.tableHalfWidth, im: y });
    const b = tf.toPx({ re: PICKUP.ballRestX + PICKUP.tableHalfWidth, im: y });
    ctx.beginPath();
    ctx.strokeStyle = colors.tableColor;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // A few short "legs" ticks for a table read.
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 2;
    for (const fx of [0.15, 0.85]) {
      const legX = a.x + (b.x - a.x) * fx;
      ctx.beginPath();
      ctx.moveTo(legX, a.y);
      ctx.lineTo(legX, a.y + 14);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draw the ball, in world coords. Drawn BETWEEN the main-chain skin and
   * the finger skin (see renderGesture) so a closed hand's fingers visibly
   * wrap around it instead of hiding it entirely.
   */
  function drawBall(ctx, tf, ballState) {
    const ballPx = tf.toPx(ballState.pos);
    const r = Math.max(4, PICKUP.ballRadius * currentScale);
    const grad = ctx.createRadialGradient(ballPx.x - r * 0.35, ballPx.y - r * 0.35, r * 0.1, ballPx.x, ballPx.y, r);
    grad.addColorStop(0, colors.accent);
    grad.addColorStop(1, colors.ballColor);
    ctx.beginPath();
    ctx.fillStyle = grad;
    ctx.arc(ballPx.x, ballPx.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.skinOutline;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function renderGesture(state, bones) {
    const { ctx, w, h } = cv;
    const kind = state.gesture && state.gesture.kind;

    if (lastT != null) {
      const raw = Math.abs(state.t - lastT);
      const circular = Math.min(raw, 1 - raw);
      if (circular > TIME_JUMP_THRESHOLD) resetTrail();
    }
    lastT = state.t;

    const { pts: mainPts, fk } = gestureMainPoints(bones, state.t);
    const { bbox, totalReach } = getGestureEnvelope(bones, kind);
    updateAutofitGesture(bbox, totalReach);

    const tf = makeTransform(currentCenter, currentScale);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);

    // Cache px positions for hit-testing + the e2e accessor.
    lastGestureJointsCss = new Map();
    for (const b of bones) {
      const p = tf.toPx(fk.get(b.id).tip);
      lastGestureJointsCss.set(b.id, { x: p.x + cv.w / 2, y: p.y + cv.h / 2 });
    }
    lastJointsCss = mainPts.map((p) => {
      const q = tf.toPx(p);
      return { x: q.x + cv.w / 2, y: q.y + cv.h / 2 };
    });

    if (interactive && !dragging && !gestureOverride && lastPointerLocal) {
      hoverBoneId = hitTestGestureJoint(lastPointerLocal.x, lastPointerLocal.y, bones, fk, tf);
      canvas.style.cursor = hoverBoneId ? 'grab' : 'default';
    }

    if (kind === 'pickup') drawTable(ctx, tf);

    let ballState = null;
    if (kind === 'pickup') ballState = pickupBallState(bones, state.t);

    // Metallic skin: main chain (arm+palm) FIRST, then the ball (if any),
    // then the 5 real finger chains ON TOP — so a closed hand's fingers
    // visibly wrap around a grasped ball instead of it disappearing inside
    // an opaque fist.
    if (skinModeFor(state, [{ label: 'gesture' }])) {
      const mainPx = mainPts.map((p) => tf.toPx(p));
      const fingersWorld = fingerWorldPoints(fk);
      const fingersPx = {};
      for (const name of Object.keys(fingersWorld)) fingersPx[name] = fingersWorld[name].map((p) => tf.toPx(p));
      const selectedIndex = MAIN_JOINT_IDS.indexOf(state.selectedId);
      const skinColors = {
        skin: colors.skin, skinShade: colors.skinShade, skinHighlight: colors.skinHighlight, outline: colors.skinOutline, bone: colors.textSecondary,
      };
      drawArmSkin(ctx, mainPx, fingersPx, {
        scalePx: currentScale, colors: skinColors, xray: true, selectedIndex, parts: 'main',
      });
      if (ballState) drawBall(ctx, tf, ballState);
      drawArmSkin(ctx, mainPx, fingersPx, {
        scalePx: currentScale, colors: skinColors, parts: 'fingers',
      });
    } else {
      // No-skin fallback: draw the bone chain as plain lines (main + fingers).
      const drawSeg = (p0w, p1w, color) => {
        const a = tf.toPx(p0w);
        const b = tf.toPx(p1w);
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      };
      let prev = { re: 0, im: 0 };
      for (const id of MAIN_JOINT_IDS) {
        const j = fk.get(id);
        drawSeg(prev, j.tip, colors.primary);
        prev = j.tip;
      }
      if (ballState) drawBall(ctx, tf, ballState);
      for (const name of FINGER_NAMES) {
        const chain = [fk.get(`${name}1`), fk.get(`${name}2`), fk.get(`${name}3`)];
        let fprev = chain[0].base;
        for (const j of chain) {
          drawSeg(fprev, j.tip, colors.accent);
          fprev = j.tip;
        }
      }
    }

    // Fading trail of the end effector (palm/hand tip's most distal finger — use middle fingertip).
    if (showTrace) {
      const tip = fk.get('middle3') ? fk.get('middle3').tip : fk.get('palm').tip;
      const last = trail[trail.length - 1];
      if (!last || (last.re - tip.re) ** 2 + (last.im - tip.im) ** 2 > 1e-10) {
        trail.push({ re: tip.re, im: tip.im });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const p0 = tf.toPx(trail[i - 1]);
        const p1 = tf.toPx(trail[i]);
        const alpha = i / trail.length;
        ctx.beginPath();
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = alpha * 0.9;
        ctx.lineWidth = 2.5;
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Base.
    {
      const base = tf.toPx({ re: 0, im: 0 });
      ctx.beginPath();
      ctx.fillStyle = colors.textSecondary;
      ctx.arc(base.x, base.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Joint handles: main chain (numbered/labeled like spin mode) + small
    // finger-joint handles (shown always but subtly; full-size on hover/selection).
    for (const id of MAIN_JOINT_IDS) {
      const j = fk.get(id);
      const selected = state.selectedId === id;
      const hovered = interactive && hoverBoneId === id;
      drawJointDot(ctx, tf, j.tip, {
        fillColor: colors.primary, selected, hovered, label: numberJoints ? String(MAIN_JOINT_IDS.indexOf(id) + 1) : null,
      });
    }
    for (const name of FINGER_NAMES) {
      for (let j = 1; j <= 3; j++) {
        const id = `${name}${j}`;
        const bone = fk.get(id);
        const selected = state.selectedId === id;
        const hovered = interactive && hoverBoneId === id;
        const px = tf.toPx(bone.tip);
        // Small: the metal hinge ring (armSkin.js) is the primary "this is a
        // joint" cue; these colored dots are just a small drag-handle accent
        // on top of it.
        const r = selected || hovered ? 4 : 1.8;
        ctx.beginPath();
        ctx.fillStyle = selected ? colors.accent : (bone && GROUP_DOT_COLOR(name));
        ctx.globalAlpha = selected || hovered ? 1 : 0.75;
        ctx.arc(px.x, px.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  function GROUP_DOT_COLOR(fingerName) {
    const map = {
      thumb: '#ffa00f', index: '#a5d75f', middle: '#8a6996', ring: '#d94415', little: '#9d162e',
    };
    return map[fingerName] || colors.accent;
  }

  function render(state, derived) {
    if (isGestureMode(state)) {
      renderGesture(state, currentBones(state));
      return;
    }
    const { ctx, w, h } = cv;
    const components = currentComponents(state) || [];

    // Reset the trail on a large time jump (scrub, preset-driven t reset,
    // etc.) so it never draws a straight chord across the discontinuity.
    if (lastT != null) {
      const raw = Math.abs(state.t - lastT);
      const circular = Math.min(raw, 1 - raw);
      if (circular > TIME_JUMP_THRESHOLD) resetTrail();
    }
    lastT = state.t;

    const bbox = computeBBox(components, state, derived);
    const totalReach = components.reduce((s, c) => s + Math.abs(c.amp), 0);
    updateAutofit(bbox, totalReach);

    const tf = makeTransform(currentCenter, currentScale);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.translate(w / 2, h / 2);

    const pts = jointPositions(components, state.t, { re: 0, im: 0 });
    lastJointsCss = pts.map((p) => {
      const q = tf.toPx(p);
      return { x: q.x + cv.w / 2, y: q.y + cv.h / 2 };
    });

    // Re-hit-test against the last-known pointer position even if the pointer
    // itself hasn't moved: the arm animates continuously, so a joint can
    // slide under (or out from under) a stationary cursor.
    if (interactive && !dragging && !componentsOverride && lastPointerLocal) {
      hoverK = hitTestJoint(lastPointerLocal.x, lastPointerLocal.y, state);
      canvas.style.cursor = hoverK >= 0 ? 'grab' : 'default';
    }

    // Faint full-period path.
    if (derived && derived.path && derived.path.length >= 4) {
      ctx.beginPath();
      ctx.strokeStyle = colors.textSecondary;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1.5;
      const path = derived.path;
      for (let i = 0; i < path.length; i += 2) {
        const p = tf.toPx({ re: path[i], im: path[i + 1] });
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Epicycle circles (faint), one per link, centered at the link's base.
    if (showCirclesFor(state) && components.length) {
      ctx.beginPath();
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for (let i = 0; i < components.length; i++) {
        const c = tf.toPx(pts[i]);
        const r = Math.abs(components[i].amp) * currentScale;
        if (r < 0.5) continue;
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Anatomical skin (bones = components; skin deforms with the bone chain).
    // Drawn before the bone links so the bones can be layered thin/translucent
    // on top of it, x-ray style. Only the first 3 components (upper arm,
    // forearm, hand) form the main chain the skin draws; the hand itself is
    // a STATIC "relaxed curl" 5-finger tree anchored at that chain's tip
    // (components 3/4, "Finger"/"Fingertip", stay part of the Fourier chain
    // and are still drawn/draggable as thin bone struts below, unchanged).
    const skinMode = skinModeFor(state, components);
    if (skinMode && components.length) {
      const jointsPxAll = pts.map((p) => tf.toPx(p));
      const mainPx = jointsPxAll.slice(0, Math.min(4, jointsPxAll.length));
      const fingersPx = {};
      const fingersWorld = spinHandFingerPoints(components, state.t, pts);
      for (const name of Object.keys(fingersWorld)) fingersPx[name] = fingersWorld[name].map((p) => tf.toPx(p));
      const selectedIndex = components.findIndex((c) => c.id === state.selectedId);
      drawArmSkin(ctx, mainPx, fingersPx, {
        scalePx: currentScale,
        colors: {
          skin: colors.skin, skinShade: colors.skinShade, skinHighlight: colors.skinHighlight, outline: colors.skinOutline, bone: colors.textSecondary,
        },
        xray: true,
        selectedIndex,
      });
    }

    // Links ("bones"). In skin mode these are drawn thin and semi-transparent
    // (x-ray) on top of the rendered skin; otherwise solid and full-width.
    for (let i = 0; i < components.length; i++) {
      const a = tf.toPx(pts[i]);
      const b = tf.toPx(pts[i + 1]);
      ctx.beginPath();
      ctx.strokeStyle = components[i].color || colors.primary;
      ctx.globalAlpha = skinMode ? 0.55 : 1;
      ctx.lineWidth = skinMode ? 1.5 : 4;
      ctx.lineCap = 'round';
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Fading trail of the end effector.
    if (showTrace && components.length) {
      const tip = pts[pts.length - 1];
      const last = trail[trail.length - 1];
      if (!last || (last.re - tip.re) ** 2 + (last.im - tip.im) ** 2 > 1e-10) {
        trail.push({ re: tip.re, im: tip.im });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const p0 = tf.toPx(trail[i - 1]);
        const p1 = tf.toPx(trail[i]);
        const alpha = i / trail.length;
        ctx.beginPath();
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = alpha * 0.9;
        ctx.lineWidth = 2.5;
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Base.
    {
      const base = tf.toPx(pts[0]);
      ctx.beginPath();
      ctx.fillStyle = colors.textSecondary;
      ctx.arc(base.x, base.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Joints (including tip).
    for (let i = 1; i < pts.length; i++) {
      const comp = components[i - 1];
      const p = tf.toPx(pts[i]);
      const selected = comp && state.selectedId === comp.id;
      const hovered = interactive && hoverK === i - 1;
      if (selected) {
        ctx.beginPath();
        ctx.fillStyle = colors.accent;
        ctx.globalAlpha = 0.25;
        ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.fillStyle = i === pts.length - 1 ? colors.accent : (comp ? comp.color || colors.primary : colors.primary);
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 1.5;
      ctx.arc(p.x, p.y, hovered ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (numberJoints) {
        ctx.fillStyle = colors.textSecondary;
        ctx.font = `11px ${THEME_FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(i), p.x, p.y - 10);
      }
    }

    ctx.restore();
  }

  // --- Interaction -------------------------------------------------------

  function localXY(evt) {
    const rect = canvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left - cv.w / 2, y: evt.clientY - rect.top - cv.h / 2 };
  }

  function hitTestJoint(px, py, state) {
    const components = currentComponents(state) || [];
    const tf = makeTransform(currentCenter, currentScale);
    const pts = jointPositions(components, state.t, { re: 0, im: 0 });
    const ptsPx = pts.map((p) => tf.toPx(p));
    const candidates = [];
    let minDist = Infinity;
    for (let i = 0; i < components.length; i++) {
      const p = ptsPx[i + 1];
      // Adaptive hit radius: when joints are bunched close together, a fixed
      // 12px radius makes several joints compete for the same click and can
      // leave one (e.g. a middle joint boxed in on both sides) ungrabbable.
      // Shrink toward half the distance to the nearest other joint, but never
      // below 6px so a truly isolated joint keeps a comfortable hit area.
      let nearestOther = Infinity;
      for (let j = 0; j < ptsPx.length; j++) {
        if (j === i + 1) continue;
        const d = Math.hypot(ptsPx[j].x - p.x, ptsPx[j].y - p.y);
        if (d < nearestOther) nearestOther = d;
      }
      const radius = Math.max(6, Math.min(HIT_RADIUS, nearestOther / 2));
      const d = Math.hypot(p.x - px, p.y - py);
      if (d > radius) continue;
      candidates.push({ i, d });
      if (d < minDist) minDist = d;
    }
    // Prefer the most distal joint that's closest: a clearly smaller distance
    // always wins, but among candidates within ~1px of the closest one,
    // prefer the higher (more distal) index, matching draw order (distal
    // joints are painted last, i.e. on top).
    let best = -1;
    for (const c of candidates) {
      if (c.d <= minDist + 1 && c.i > best) best = c.i;
    }
    return best;
  }

  /** Same adaptive-radius nearest-joint search as hitTestJoint, over the gesture bone tree. */
  function hitTestGestureJoint(px, py, bones, fk, tf) {
    const all = bones.map((b) => ({ id: b.id, p: tf.toPx(fk.get(b.id).tip) }));
    let best = null;
    let bestDist = Infinity;
    for (const j of all) {
      let nearestOther = Infinity;
      for (const other of all) {
        if (other.id === j.id) continue;
        const d = Math.hypot(other.p.x - j.p.x, other.p.y - j.p.y);
        if (d < nearestOther) nearestOther = d;
      }
      const radius = Math.max(5, Math.min(HIT_RADIUS, nearestOther / 2));
      const d = Math.hypot(j.p.x - px, j.p.y - py);
      if (d <= radius && d < bestDist) {
        bestDist = d;
        best = j.id;
      }
    }
    return best;
  }

  /** Clamp a local (canvas-center-relative) point to stay within the visible canvas. */
  function clampToCanvas(x, y) {
    return {
      x: Math.max(-cv.w / 2, Math.min(cv.w / 2, x)),
      y: Math.max(-cv.h / 2, Math.min(cv.h / 2, y)),
    };
  }

  function onPointerMoveHover(evt) {
    if (!interactive || dragging) return;
    const { x, y } = localXY(evt);
    lastPointerLocal = { x, y };
    const state = store.get();
    if (isGestureMode(state)) {
      if (gestureOverride) return;
      const bones = currentBones(state);
      const { fk } = gestureMainPoints(bones, state.t);
      const tf = makeTransform(currentCenter, currentScale);
      hoverBoneId = hitTestGestureJoint(x, y, bones, fk, tf);
      canvas.style.cursor = hoverBoneId ? 'grab' : 'default';
      return;
    }
    if (componentsOverride) return;
    hoverK = hitTestJoint(x, y, state);
    canvas.style.cursor = hoverK >= 0 ? 'grab' : 'default';
  }

  function onPointerDown(evt) {
    if (!interactive) return;
    const { x, y } = localXY(evt);
    lastPointerLocal = { x, y };
    const state = store.get();

    if (isGestureMode(state)) {
      if (gestureOverride) return;
      const bones = currentBones(state);
      const { fk } = gestureMainPoints(bones, state.t);
      const tf = makeTransform(currentCenter, currentScale);
      const id = hitTestGestureJoint(x, y, bones, fk, tf);
      if (!id) return;
      const bone = bones.find((b) => b.id === id);
      const parentAbsAngle = fk.get(id).absAngle - fk.get(id).relAngle;
      store.set({ selectedId: id }, 'arm');
      dragging = { pointerId: evt.pointerId, boneId: id, parentAbsAngle, series: bone.series };
      store.set({ dragging: true }, 'arm');
      canvas.setPointerCapture(evt.pointerId);
      canvas.style.cursor = 'grabbing';
      evt.preventDefault();
      return;
    }

    if (componentsOverride) return;
    const k = hitTestJoint(x, y, state);
    if (k < 0) return;
    const components = currentComponents(state);
    const comp = components[k];
    store.set({ selectedId: comp.id }, 'arm');
    dragging = { pointerId: evt.pointerId, k, id: comp.id };
    store.set({ dragging: true }, 'arm');
    canvas.setPointerCapture(evt.pointerId);
    canvas.style.cursor = 'grabbing';
    evt.preventDefault();
  }

  function onPointerMove(evt) {
    if (dragging && dragging.pointerId === evt.pointerId) {
      const raw = localXY(evt);
      const { x, y } = clampToCanvas(raw.x, raw.y);
      lastPointerLocal = { x, y };
      const state = store.get();
      const tf = makeTransform(currentCenter, currentScale);
      const worldP = tf.toWorld(x, y);

      if (dragging.boneId != null) {
        // Gesture mode: a plain drag ROTATES the joint's mean only (the
        // oscillation continues around the new mean); everything downstream
        // follows automatically through forward kinematics on the next render.
        const bones = currentBones(state);
        const bone = bones.find((b) => b.id === dragging.boneId);
        const fk = forwardKinematics(bones, state.t);
        const base = fk.get(dragging.boneId).base;
        const desiredAbsAngle = Math.atan2(worldP.im - base.im, worldP.re - base.re);
        const harmonicSum = evalSeries(bone.series, state.t) - bone.series.mean;
        const newMean = desiredAbsAngle - dragging.parentAbsAngle - harmonicSum;
        store.updateJointMean(dragging.boneId, newMean, 'arm');
        evt.preventDefault();
        return;
      }

      const components = currentComponents(state);
      const result = invertDrag(components, dragging.k, worldP, state.t, { re: 0, im: 0 });
      const amp = Math.min(MAX_AMP, result.amp);
      if (skinModeFor(state, components) && !evt.shiftKey) {
        // Anatomical mode: a plain drag rotates the bone only (keeps its
        // length/amp so the arm doesn't stretch); shift+drag allows full
        // amp+phase re-solve like the non-skin arm.
        store.updateComponent(dragging.id, { phase: result.phase }, 'arm');
      } else {
        store.updateComponent(dragging.id, { amp, phase: result.phase }, 'arm');
      }
      evt.preventDefault();
      return;
    }
    onPointerMoveHover(evt);
  }

  /**
   * touch-action can't be changed mid-gesture, so this non-passive listener
   * cancels the browser's default pan only when the touch actually starts on
   * a joint (so that gesture drags instead of scrolling); any other touch on
   * the canvas is left alone and the page scrolls normally.
   */
  function onTouchStart(evt) {
    if (!interactive) return;
    const touch = evt.touches && evt.touches[0];
    if (!touch) return;
    const { x, y } = localXY(touch);
    const state = store.get();
    if (isGestureMode(state)) {
      if (gestureOverride) return;
      const bones = currentBones(state);
      const { fk } = gestureMainPoints(bones, state.t);
      const tf = makeTransform(currentCenter, currentScale);
      if (hitTestGestureJoint(x, y, bones, fk, tf)) evt.preventDefault();
      return;
    }
    if (componentsOverride) return;
    if (hitTestJoint(x, y, state) >= 0) evt.preventDefault();
  }

  function onPointerUp(evt) {
    if (dragging && dragging.pointerId === evt.pointerId) {
      try { canvas.releasePointerCapture(evt.pointerId); } catch { /* noop */ }
      dragging = null;
      justReleased = true;
      store.set({ dragging: false }, 'arm');
      canvas.style.cursor = (hoverK >= 0 || hoverBoneId) ? 'grab' : 'default';
    }
  }

  if (interactive) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('pointerleave', () => {
      if (!dragging) {
        hoverK = -1;
        hoverBoneId = null;
        lastPointerLocal = null;
        canvas.style.cursor = 'default';
      }
    });
  }

  function resize() {
    cv.refresh();
  }

  function destroy() {
    document.removeEventListener('themechange', onThemeChange);
    unsubscribeComponents();
    if (interactive) {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('touchstart', onTouchStart);
    }
    cv.destroy();
  }

  /** Joint positions from the last render, in CSS px relative to the canvas's top-left (p_0 = base). Spin mode: full chain. Gesture mode: the 4 main-chain points. */
  function jointsPx() {
    return lastJointsCss.map((p) => ({ ...p }));
  }

  /** Gesture mode only: every one of the 18 joints' last-rendered px position, keyed by bone id (e.g. 'upperArm', 'index2'). */
  function gestureJointsPx() {
    const out = {};
    for (const [id, p] of lastGestureJointsCss) out[id] = { ...p };
    return out;
  }

  return {
    render, resize, destroy, jointsPx, gestureJointsPx, resetTrail,
  };
}
