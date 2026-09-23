// Robot-arm / epicycle view: chain of links (Fourier components), joint dragging,
// end-effector trace + fading trail.
import { setupCanvas, makeTransform, cssVar } from './canvas.js';
import { jointPositions, invertDrag } from '../core/arm.js';
import { drawArmSkin, isAnatomical } from './armSkin.js';
import { MAX_AMP } from '../core/store.js';

const HIT_RADIUS = 12; // px, joint-tip hit test
const TRAIL_MAX = 90; // recent-tip trail length (frames)
const FIT_MARGIN = 0.08; // fraction of each side reserved as margin around the fitted bbox
const SCALE_EASE = 0.12; // per-render lerp factor for autofit scale/center (frozen while dragging)
const TIME_JUMP_THRESHOLD = 0.05; // fraction of a period; a bigger circular jump resets the trail
const THEME_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import('../core/store.js').createStore>} store
 * @param {{interactive?: boolean, showTrace?: boolean, showCircles?: boolean,
 *          numberJoints?: boolean, componentsOverride?: () => Array<object>,
 *          skin?: boolean}} [opts] - `skin` (else `state.showSkin`) renders an
 *          anatomical arm (armSkin.js) with bones drawn thin/translucent on top.
 */
export function createArmView(canvas, store, opts = {}) {
  let lastJointsCss = [];
  const {
    interactive = true,
    showTrace = true,
    numberJoints = false,
    componentsOverride = null,
  } = opts;

  const cv = setupCanvas(canvas);
  if (interactive) canvas.style.touchAction = 'none';
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
      skin: cssVar('--skin', '#e8b894'),
      skinShade: cssVar('--skin-shade', '#c98f6b'),
      skinOutline: cssVar('--skin-outline', '#7a4a32'),
    };
  }
  const onThemeChange = () => { colors = readColors(); };
  document.addEventListener('themechange', onThemeChange);

  let currentScale = 1;
  let currentCenter = { re: 0, im: 0 };
  let viewInitialized = false;
  const trail = []; // { re, im } most-recent-last
  let lastT = null;

  // Drag state
  let dragging = null; // { pointerId, k, id }
  let hoverK = -1;
  let lastPointerLocal = null; // { x, y } in canvas-center-relative local coords, for re-hit-testing on render

  function currentComponents(state) {
    return componentsOverride ? componentsOverride() : state.components;
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

  // Track the source of the most recent components change, so autofit can
  // tell "the user is manipulating the arm" (source 'arm': a joint drag)
  // apart from "the shape changed underneath them" (preset load, editor
  // edit, drawing, a spectrum-stem drag). Also resets the fading trail
  // whenever the change came from outside this view, so it never draws a
  // straight chord from the old shape's tip to the new one's.
  let lastComponentsSource = null;
  const unsubscribeComponents = store.subscribe((state, changedKeys, source) => {
    lastComponentsSource = source;
    if (source !== 'arm') resetTrail();
  }, ['components']);

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

  /** Auto-fit target (scale + center) for a bbox, with an 8%-of-canvas margin. */
  function fitTargetFromBBox(bbox) {
    const availW = Math.max(1, cv.w * (1 - 2 * FIT_MARGIN));
    const availH = Math.max(1, cv.h * (1 - 2 * FIT_MARGIN));
    const scale = Math.min(availW / Math.max(bbox.bboxW, 1e-6), availH / Math.max(bbox.bboxH, 1e-6));
    return { scale, center: { re: bbox.cx, im: bbox.cy } };
  }

  /**
   * `true` iff `bbox`, drawn with the CURRENT (not target) view, would spill
   * past the canvas edge (i.e. actually leave the visible canvas) — NOT
   * merely past the cosmetic margin. A small, in-frame arm-drag nudges the
   * full-period path's bbox slightly on every edit; re-fitting for that
   * would make the view visibly drift right as the user releases the
   * pointer, so only a real "gone off-screen" case should force a re-fit
   * while the most recent change came from the arm itself.
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

  function render(state, derived) {
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
    if (!viewInitialized) {
      const target = fitTargetFromBBox(bbox);
      currentScale = target.scale;
      currentCenter = target.center;
      viewInitialized = true;
    } else if (!dragging) {
      // Stay put while the user is manipulating the arm (the most recent
      // components change came from a joint drag): re-fitting on every
      // frame would make the shoulder/base visibly drift as soon as they
      // release, even for a small, in-frame adjustment. Only re-fit for a
      // drag-sourced change if it actually pushed the arm/path out of view;
      // any other source (preset, editor, draw, spectrum) always re-fits.
      const shouldRefit = lastComponentsSource !== 'arm' || overflowsCanvas(bbox);
      if (shouldRefit) {
        const target = fitTargetFromBBox(bbox);
        currentScale += (target.scale - currentScale) * SCALE_EASE;
        currentCenter = {
          re: currentCenter.re + (target.center.re - currentCenter.re) * SCALE_EASE,
          im: currentCenter.im + (target.center.im - currentCenter.im) * SCALE_EASE,
        };
      }
    }

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
    // on top of it, x-ray style.
    const skinMode = skinModeFor(state, components);
    if (skinMode && components.length) {
      const jointsPx = pts.map((p) => tf.toPx(p));
      const selectedIndex = components.findIndex((c) => c.id === state.selectedId);
      drawArmSkin(ctx, jointsPx, {
        scalePx: currentScale,
        colors: {
          skin: colors.skin,
          skinShade: colors.skinShade,
          outline: colors.skinOutline,
          bone: colors.textSecondary,
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
    let best = -1;
    let bestDist = HIT_RADIUS;
    for (let i = 0; i < components.length; i++) {
      const p = tf.toPx(pts[i + 1]);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= bestDist) {
        bestDist = d;
        best = i;
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
    if (!interactive || dragging || componentsOverride) return;
    const { x, y } = localXY(evt);
    lastPointerLocal = { x, y };
    const state = store.get();
    hoverK = hitTestJoint(x, y, state);
    canvas.style.cursor = hoverK >= 0 ? 'grab' : 'default';
  }

  function onPointerDown(evt) {
    if (!interactive || componentsOverride) return;
    const { x, y } = localXY(evt);
    lastPointerLocal = { x, y };
    const state = store.get();
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
      const components = currentComponents(state);
      const tf = makeTransform(currentCenter, currentScale);
      const worldP = tf.toWorld(x, y);
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

  function onPointerUp(evt) {
    if (dragging && dragging.pointerId === evt.pointerId) {
      try { canvas.releasePointerCapture(evt.pointerId); } catch { /* noop */ }
      dragging = null;
      store.set({ dragging: false }, 'arm');
      canvas.style.cursor = hoverK >= 0 ? 'grab' : 'default';
    }
  }

  if (interactive) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      if (!dragging) {
        hoverK = -1;
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
    }
    cv.destroy();
  }

  /** Joint positions from the last render, in CSS px relative to the canvas's top-left (p_0 = base). */
  function jointsPx() {
    return lastJointsCss.map((p) => ({ ...p }));
  }

  return { render, resize, destroy, jointsPx };
}
