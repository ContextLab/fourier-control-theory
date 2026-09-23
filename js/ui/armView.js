// Robot-arm / epicycle view: chain of links (Fourier components), joint dragging,
// end-effector trace + fading trail.
import { setupCanvas, makeTransform, cssVar } from './canvas.js';
import { jointPositions, invertDrag } from '../core/arm.js';
import { drawArmSkin } from './armSkin.js';

const HIT_RADIUS = 12; // px, joint-tip hit test
const TRAIL_MAX = 90; // recent-tip trail length (frames)
const FIT_MARGIN = 0.82; // fraction of half-viewport the max reach should fill
const SCALE_EASE = 0.12; // per-render lerp factor for autofit scale (frozen while dragging)

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
  let scaleInitialized = false;
  const trail = []; // { re, im } most-recent-last

  // Drag state
  let dragging = null; // { pointerId, k, id }
  let hoverK = -1;

  function currentComponents(state) {
    return componentsOverride ? componentsOverride() : state.components;
  }

  function showCirclesFor(state) {
    if (opts.showCircles !== undefined) return opts.showCircles;
    return !!state.showCircles;
  }

  function skinModeFor(state) {
    return !!(opts.skin ?? state.showSkin);
  }

  function fitScale(components) {
    let reach = 0;
    for (const c of components) reach += Math.abs(c.amp);
    if (reach < 1e-6) reach = 1;
    const half = Math.min(cv.w, cv.h) / 2;
    return (half * FIT_MARGIN) / reach;
  }

  function render(state, derived) {
    const { ctx, w, h } = cv;
    const components = currentComponents(state) || [];

    const target = fitScale(components);
    if (!scaleInitialized) {
      currentScale = target;
      scaleInitialized = true;
    } else if (!dragging) {
      currentScale += (target - currentScale) * SCALE_EASE;
    }

    const tf = makeTransform({ re: 0, im: 0 }, currentScale);

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
    const skinMode = skinModeFor(state);
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
        ctx.font = '11px sans-serif';
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
    const tf = makeTransform({ re: 0, im: 0 }, currentScale);
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

  function onPointerMoveHover(evt) {
    if (!interactive || dragging || componentsOverride) return;
    const { x, y } = localXY(evt);
    const state = store.get();
    hoverK = hitTestJoint(x, y, state);
    canvas.style.cursor = hoverK >= 0 ? 'grab' : 'default';
  }

  function onPointerDown(evt) {
    if (!interactive || componentsOverride) return;
    const { x, y } = localXY(evt);
    const state = store.get();
    const k = hitTestJoint(x, y, state);
    if (k < 0) return;
    const components = currentComponents(state);
    const comp = components[k];
    store.set({ selectedId: comp.id }, 'arm');
    dragging = { pointerId: evt.pointerId, k, id: comp.id };
    canvas.setPointerCapture(evt.pointerId);
    canvas.style.cursor = 'grabbing';
    evt.preventDefault();
  }

  function onPointerMove(evt) {
    if (dragging && dragging.pointerId === evt.pointerId) {
      const { x, y } = localXY(evt);
      const state = store.get();
      const components = currentComponents(state);
      const tf = makeTransform({ re: 0, im: 0 }, currentScale);
      const worldP = tf.toWorld(x, y);
      const result = invertDrag(components, dragging.k, worldP, state.t, { re: 0, im: 0 });
      if (skinModeFor(state) && !evt.shiftKey) {
        // Anatomical mode: a plain drag rotates the bone only (keeps its
        // length/amp so the arm doesn't stretch); shift+drag allows full
        // amp+phase re-solve like the non-skin arm.
        store.updateComponent(dragging.id, { phase: result.phase }, 'arm');
      } else {
        store.updateComponent(dragging.id, { amp: result.amp, phase: result.phase }, 'arm');
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
        canvas.style.cursor = 'default';
      }
    });
  }

  function resize() {
    cv.refresh();
  }

  function destroy() {
    document.removeEventListener('themechange', onThemeChange);
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
