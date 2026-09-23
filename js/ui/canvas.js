// HiDPI canvas helper + world<->pixel transform. No dependencies on core.

/**
 * Reads a CSS custom property from :root (document.documentElement), trimmed.
 * @param {string} name e.g. '--primary-color'
 * @param {string} [fallback]
 * @returns {string}
 */
export function cssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  const trimmed = v ? v.trim() : '';
  return trimmed || fallback;
}

/**
 * Sets up a canvas for crisp HiDPI rendering and keeps it current via ResizeObserver.
 * Returns a live object {ctx, w, h, dpr} — w/h are CSS pixel dimensions; the backing
 * store is sized css*dpr and ctx has setTransform(dpr,0,0,dpr,0,0) applied so callers
 * draw in CSS-pixel coordinates.
 * @param {HTMLCanvasElement} canvas
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, destroy: () => void}}
 */
export function setupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const state = { ctx, w: 0, h: 0, dpr: 1 };

  function applySize() {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const backingW = Math.max(1, Math.round(cssW * dpr));
    const backingH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.w = cssW;
    state.h = cssH;
    state.dpr = dpr;
  }

  applySize();

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => applySize());
    ro.observe(canvas);
  } else {
    // Fallback for environments without ResizeObserver.
    window.addEventListener('resize', applySize);
  }

  state.destroy = () => {
    if (ro) ro.disconnect();
    else window.removeEventListener('resize', applySize);
  };

  // Forces an immediate re-measurement (useful right after the canvas becomes
  // visible, e.g. a tab switch, when a ResizeObserver callback may lag a frame).
  state.refresh = () => applySize();

  return state;
}

/**
 * Builds a world<->pixel transform. World space has y-up; pixel space has y-down
 * (standard canvas convention). `center` is the world-space point that maps to
 * pixel (0, 0); `scale` is pixels per world unit (bigger scale = more zoomed in).
 *
 * This transform is origin-relative, not viewport-relative: callers that want world
 * (0,0) drawn at the canvas center should `ctx.translate(w/2, h/2)` before drawing
 * with toPx()'s output, and should subtract (w/2, h/2) from raw pointer coordinates
 * before passing them to toWorld(). This keeps makeTransform decoupled from any
 * particular canvas's live size.
 * @param {{re:number, im:number}} center world-space point mapped to pixel (0,0)
 * @param {number} scale pixels per world unit
 * @returns {{toPx: (z:{re:number,im:number}) => {x:number,y:number}, toWorld: (x:number,y:number) => {re:number,im:number}}}
 */
export function makeTransform(center, scale) {
  return {
    toPx(z) {
      return {
        x: (z.re - center.re) * scale,
        y: -(z.im - center.im) * scale,
      };
    },
    toWorld(x, y) {
      return {
        re: center.re + x / scale,
        im: center.im - y / scale,
      };
    },
  };
}
