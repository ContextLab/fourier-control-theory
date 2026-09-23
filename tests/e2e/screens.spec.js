// @ts-check
// End-to-end smoke tests for the Fourier <-> Control Theory demo.
//
// These exercise the real page in a real Chromium instance (no mocks): real
// pointer drags, real DOM state, a real static file server. Exact pixel
// positions of joints/stems are not part of the frozen contract (see
// notes/plan.md), so drag tests probe a small grid of candidate points and
// require at least one of them to produce a real, observable state change
// (an editor input value changing) rather than asserting a specific pixel.
//
// NOTE for whoever runs this after js/*.js and index.html land: if every
// candidate in a probe grid fails, that is a real signal worth reporting
// (see the WP4 handoff report) rather than papering over by widening the
// grid until something passes by accident.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Pure function, safe to import under Node (no DOM access at import time or
// within sliderToK itself) — used to invert the draw view's log-scale K
// slider mapping so tests can set an exact target K without duplicating or
// guessing at drawView.js's internal formula.
import { sliderToK, K_MAX } from '../../js/ui/drawView.js';
import { idftEval } from '../../js/core/fourier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENS_DIR = path.join(__dirname, 'screens');

const TABS = ['arm', 'draw', 'control'];
const THEMES = ['dark', 'light'];

/** Collect console errors + page errors for the duration of a callback. */
async function collectErrors(page, fn) {
  const errors = [];
  const onConsole = (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  };
  const onPageError = (err) => errors.push(`pageerror: ${err.message}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    await fn();
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
  return errors;
}

async function gotoApp(page) {
  const errors = await collectErrors(page, async () => {
    await page.goto('/index.html');
    await page.waitForSelector('#tab-arm', { timeout: 10_000 });
  });
  return errors;
}

async function setTheme(page, theme) {
  const current = await page.getAttribute('html', 'data-theme');
  const isLight = current === 'light';
  if ((theme === 'light') !== isLight) {
    await page.click('#theme-toggle');
  }
}

/** Read the first numeric input inside #editor (used as a change probe). */
async function firstEditorNumber(page) {
  const inputs = page.locator('#editor input[type="number"]');
  const count = await inputs.count();
  if (count === 0) return null;
  return inputs.first().inputValue();
}

async function allEditorNumbers(page) {
  const inputs = page.locator('#editor input[type="number"]');
  const count = await inputs.count();
  const values = [];
  for (let i = 0; i < count; i++) values.push(await inputs.nth(i).inputValue());
  return values;
}

test.describe('screenshots per mode/theme', () => {
  for (const tabName of TABS) {
    for (const theme of THEMES) {
      test(`${tabName} tab, ${theme} theme`, async ({ page }) => {
        await gotoApp(page);
        await page.click(`#tab-${tabName}`);
        await setTheme(page, theme);
        // let one animation frame settle
        await page.waitForTimeout(150);
        await page.screenshot({
          path: path.join(SCREENS_DIR, `${tabName}-${theme}.png`),
          fullPage: true,
        });
        const canvasId =
          tabName === 'arm' ? '#arm-canvas' : tabName === 'draw' ? '#draw-canvas' : '#joint-canvas';
        await expect(page.locator(canvasId)).toBeVisible();
      });
    }
  }
});

test('no console errors across a full interaction pass, including a real draw', async ({ page }) => {
  const errors = await collectErrors(page, async () => {
    await page.goto('/index.html');
    await page.waitForSelector('#tab-arm', { timeout: 10_000 });
    for (const tabName of TABS) {
      await page.click(`#tab-${tabName}`);
      await page.waitForTimeout(100);
    }
    await page.click('#theme-toggle');
    await page.click('#tab-draw');
    await drawStarOnCanvas(page);
    const kSlider = page.locator('#k-slider');
    await kSlider.fill('100');
    await kSlider.dispatchEvent('input');
    await page.waitForTimeout(100);
    await page.click('#tab-arm'); // #play lives in the Arm tab's transport bar
    await page.click('#play');
    await page.waitForTimeout(300);
  });
  expect(errors, `Unexpected console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('tutorial renders more than 10 KaTeX elements', async ({ page }) => {
  await gotoApp(page);
  await page.waitForSelector('.katex', { timeout: 10_000 });
  const count = await page.locator('.katex').count();
  expect(count).toBeGreaterThan(10);
});

/** Pause playback (so joints stay put) and return the canvas box. */
async function pauseAndBox(page, selector) {
  await page.evaluate(() => window.fourierDemo.store.set({ playing: false }, 'test'));
  // Views ease their auto-fit zoom/axes in over several frames; wait until the
  // drawn joints and stem heads stop moving before aiming the mouse at them.
  await page.waitForFunction(() => {
    const d = window.fourierDemo;
    const snap = JSON.stringify([d.armView.jointsPx(), d.spectrumView.stemHeads()]);
    const same = snap === window.__lastSnap;
    window.__lastSnap = snap;
    return same;
  }, null, { polling: 200, timeout: 10_000 });
  await page.locator(selector).scrollIntoViewIfNeeded();
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} must have a bounding box`).toBeTruthy();
  return box;
}

const comps = (page) =>
  page.evaluate(() => window.fourierDemo.store.get().components.map((c) => ({ ...c })));

test('dragging a joint tip rotates that bone, keeps upstream fixed, and updates the editor', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  // This test exercises Fourier-spin mode's own drag contract; gesture mode
  // (the app's default preset) is covered by its own gesture-specific tests below.
  await page.selectOption('#presets', 'arm');
  await page.waitForTimeout(50);
  const box = await pauseAndBox(page, '#arm-canvas');

  const before = await comps(page);
  const editorBefore = await allEditorNumbers(page);
  const joints = await page.evaluate(() => window.fourierDemo.armView.jointsPx());
  expect(joints.length).toBe(before.length + 1);

  // Drag the elbow (tip of link 0, the upper arm) perpendicular to the bone.
  const base = joints[0];
  const tip = joints[1];
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  await page.mouse.move(box.x + tip.x, box.y + tip.y);
  await page.mouse.down();
  await page.mouse.move(box.x + tip.x + nx * 40, box.y + tip.y + ny * 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  const after = await comps(page);
  // Skin mode (default): plain drag rotates only; bone length (amp) is preserved.
  expect(after[0].amp).toBeCloseTo(before[0].amp, 9);
  expect(Math.abs(after[0].phase - before[0].phase)).toBeGreaterThan(0.1);
  // Downstream links keep their own coefficients (they ride along rigidly).
  for (let i = 1; i < before.length; i++) {
    expect(after[i].amp).toBeCloseTo(before[i].amp, 9);
    expect(after[i].phase).toBeCloseTo(before[i].phase, 9);
  }
  // The shoulder stays where it was, and the rest of the chain is still attached.
  const jointsAfter = await page.evaluate(() => window.fourierDemo.armView.jointsPx());
  expect(jointsAfter[0].x).toBeCloseTo(base.x, 1);
  expect(jointsAfter[0].y).toBeCloseTo(base.y, 1);
  expect(await allEditorNumbers(page)).not.toEqual(editorBefore);

  // Shift-drag outward changes the bone length.
  const t1 = jointsAfter[1];
  const ux = (t1.x - base.x) / Math.hypot(t1.x - base.x, t1.y - base.y);
  const uy = (t1.y - base.y) / Math.hypot(t1.x - base.x, t1.y - base.y);
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + t1.x, box.y + t1.y);
  await page.mouse.down();
  await page.mouse.move(box.x + t1.x + ux * 30, box.y + t1.y + uy * 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
  const afterShift = await comps(page);
  expect(afterShift[0].amp).toBeGreaterThan(after[0].amp * 1.05);
});

test('dragging a spectrum stem upward increases that component amplitude', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm'); // this test exercises Fourier-spin mode's spectrum stems
  await page.waitForTimeout(50);
  const box = await pauseAndBox(page, '#spectrum-canvas');

  const before = await comps(page);
  const editorBefore = await allEditorNumbers(page);
  const heads = await page.evaluate(() => window.fourierDemo.spectrumView.stemHeads());
  expect(heads.length).toBe(before.length);

  const h = heads[heads.length - 1]; // smallest-amplitude component
  await page.mouse.move(box.x + h.x, box.y + h.y);
  await page.mouse.down();
  await page.mouse.move(box.x + h.x, box.y + h.y - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  const after = await comps(page);
  const b = before.find((c) => c.id === h.id);
  const a = after.find((c) => c.id === h.id);
  expect(a.amp).toBeGreaterThan(b.amp);
  expect(a.freq).toBe(b.freq); // purely vertical drag must not change frequency
  expect(await allEditorNumbers(page)).not.toEqual(editorBefore);
});

/** Draws a real, recognizable closed stroke (a 5-pointed star) on #draw-canvas via page.mouse. */
async function drawStarOnCanvas(page) {
  const canvas = page.locator('#draw-canvas');
  const box = await canvas.boundingBox();
  expect(box, '#draw-canvas must have a bounding box').toBeTruthy();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const scale = Math.min(box.width, box.height) / 3;

  const points = 5;
  const outer = 1;
  const inner = 0.4;
  const star = [];
  const steps = points * 2;
  for (let i = 0; i <= steps; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const theta = (i / steps) * 2 * Math.PI - Math.PI / 2;
    star.push([cx + Math.cos(theta) * r * scale, cy + Math.sin(theta) * r * scale]);
  }

  await page.mouse.move(star[0][0], star[0][1]);
  await page.mouse.down();
  for (const [x, y] of star.slice(1)) {
    await page.mouse.move(x, y, { steps: 4 });
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  return box;
}

/** Reads state.drawing.coeffs via the store and asserts every {re,im} pair is finite. */
async function expectFiniteCoeffs(page) {
  const coeffs = await page.evaluate(() => window.fourierDemo.store.get().drawing.coeffs);
  expect(coeffs.length, 'drawing.coeffs must be non-empty after a real stroke').toBeGreaterThan(0);
  for (const { c } of coeffs) {
    expect(Number.isFinite(c.re), `coefficient re must be finite, got ${c.re}`).toBe(true);
    expect(Number.isFinite(c.im), `coefficient im must be finite, got ${c.im}`).toBe(true);
  }
}

async function readRms(page) {
  const text = await page.locator('#rms-readout').textContent();
  return parseFloat(text);
}

/**
 * The K slider is log-scaled (see drawView.js sliderToK), so its raw
 * position is NOT the displayed K (e.g. filling '5' can yield K=1). Find a
 * raw position that maps to exactly `targetK` under the slider's own
 * current min/max, so the test can assert an exact K without guessing.
 */
async function findSliderPosForK(page, targetK) {
  const { min, max } = await page.evaluate(() => {
    const el = document.getElementById('k-slider');
    return { min: Number(el.min) || 0, max: Number(el.max) || 1000 };
  });
  for (let pos = min; pos <= max; pos++) {
    if (sliderToK(pos, min, max) === targetK) return pos;
  }
  throw new Error(`no k-slider position in [${min}, ${max}] maps to K=${targetK}`);
}

test('draw mode: freehand star, then K=5 and K=100 both give a finite, improving reconstruction', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-draw');
  await page.waitForTimeout(150);

  // Drawing must work directly (no need to press "Draw" first).
  await drawStarOnCanvas(page);

  // The stroke must have actually been captured: finite DFT coefficients,
  // not the pre-fix NaN-from-{re,im}-vs-{x,y} bug.
  await expectFiniteCoeffs(page);

  const kSlider = page.locator('#k-slider');
  await expect(kSlider).toBeVisible();

  const pos5 = await findSliderPosForK(page, 5);
  await kSlider.fill(String(pos5));
  await kSlider.dispatchEvent('input');
  await kSlider.dispatchEvent('change');
  await page.waitForTimeout(100);
  expect(await page.locator('#k-value').textContent()).toBe('5');
  const rmsAt5 = await readRms(page);
  expect(Number.isFinite(rmsAt5), `RMS readout at K=5 must be finite, got "${await page.locator('#rms-readout').textContent()}"`).toBe(true);
  await page.screenshot({ path: path.join(SCREENS_DIR, 'draw-star-k5.png') });

  const pos100 = await findSliderPosForK(page, 100);
  await kSlider.fill(String(pos100));
  await kSlider.dispatchEvent('input');
  await kSlider.dispatchEvent('change');
  await page.waitForTimeout(100);
  expect(await page.locator('#k-value').textContent()).toBe('100');
  const rmsAt100 = await readRms(page);
  expect(Number.isFinite(rmsAt100), `RMS readout at K=100 must be finite, got "${await page.locator('#rms-readout').textContent()}"`).toBe(true);
  await page.screenshot({ path: path.join(SCREENS_DIR, 'draw-star-k100.png') });

  // More terms must reconstruct the stroke at least as well.
  expect(rmsAt100, `RMS(K=100)=${rmsAt100} should be < RMS(K=5)=${rmsAt5}`).toBeLessThan(rmsAt5);
});

test('draw mode: a tiny/degenerate stroke is rejected with a hint, not NaN', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-draw');
  await page.waitForTimeout(150);

  const before = await page.evaluate(() => window.fourierDemo.store.get().drawing.coeffs.length);

  const canvas = page.locator('#draw-canvas');
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A near-stationary tap: well under both the point-count and extent floors.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 1, cy + 1);
  await page.mouse.up();
  await page.waitForTimeout(100);

  const after = await page.evaluate(() => window.fourierDemo.store.get().drawing);
  expect(after.coeffs.length, 'a degenerate stroke must not replace the existing reconstruction').toBe(before);
  for (const { c } of after.coeffs) {
    expect(Number.isFinite(c.re)).toBe(true);
    expect(Number.isFinite(c.im)).toBe(true);
  }
  const hint = await page.locator('#draw-hint').textContent();
  expect(hint.toLowerCase()).toMatch(/short|closed shape/);
});

// ---------------------------------------------------------------------------
// Contract tests for other fixers' work (notes/redteam/fix-plan.md). These
// target the AGREED contracts, not today's code, since B/C/D/E's files are
// changing concurrently; run the full suite once everyone's work has landed.
// ---------------------------------------------------------------------------

// js/core/store.js is the single source of truth for these limits (owner: F)
// and they've changed over the course of red-teaming (64 -> 256), so read
// them from the live module instead of hardcoding a number here that would
// silently drift out of sync and either weaken or spuriously fail the test.
async function getLimits(page) {
  return page.evaluate(() => import('/js/core/store.js').then((m) => ({ MAX_FREQ: m.MAX_FREQ, MAX_AMP: m.MAX_AMP })));
}

test('spectrum: dragging a stem far past the right edge keeps |freq| within MAX_FREQ', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm'); // Fourier-spin mode's spectrum, not gesture mode's
  await page.waitForTimeout(50);
  const { MAX_FREQ } = await getLimits(page);
  const box = await pauseAndBox(page, '#spectrum-canvas');
  const heads = await page.evaluate(() => window.fourierDemo.spectrumView.stemHeads());
  const h = heads[0];

  await page.mouse.move(box.x + h.x, box.y + h.y);
  await page.mouse.down();
  // Drag far past the right edge and hold there for several samples, so a
  // runaway (the axis re-scaling under the pointer, letting freq climb
  // without bound) would show up as an ever-increasing value.
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(box.x + box.width * 4, box.y + h.y, { steps: 3 });
    await page.waitForTimeout(30);
    const f = await page.evaluate(
      (id) => window.fourierDemo.store.get().components.find((c) => c.id === id)?.freq,
      h.id,
    );
    seen.push(f);
  }
  await page.mouse.up();
  await page.waitForTimeout(100);

  for (const f of seen) {
    expect(Number.isFinite(f), `freq sample must be finite, got ${f}`).toBe(true);
    expect(Math.abs(f), `freq must stay within +/-${MAX_FREQ} while held, got ${f}`).toBeLessThanOrEqual(MAX_FREQ);
  }
  const after = await comps(page);
  const comp = after.find((c) => c.id === h.id);
  expect(Math.abs(comp.freq)).toBeLessThanOrEqual(MAX_FREQ);
});

test('arm: shift-dragging a joint far off-canvas keeps amp within MAX_AMP', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm'); // shift-drag-changes-length is a Fourier-spin-mode contract
  await page.waitForTimeout(50);
  const { MAX_AMP } = await getLimits(page);
  const box = await pauseAndBox(page, '#arm-canvas');
  const joints = await page.evaluate(() => window.fourierDemo.armView.jointsPx());
  const tip = joints[1];

  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + tip.x, box.y + tip.y);
  await page.mouse.down();
  await page.mouse.move(box.x + tip.x + 3000, box.y + tip.y + 3000, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(100);

  const after = await comps(page);
  for (const c of after) {
    expect(Number.isFinite(c.amp), `amp must be finite, got ${c.amp} for id ${c.id}`).toBe(true);
    expect(c.amp, `amp must stay <= ${MAX_AMP}, got ${c.amp} for id ${c.id}`).toBeLessThanOrEqual(MAX_AMP);
  }
});

test('editor: freq input of 1e6 is clamped within MAX_FREQ and frame time stays reasonable', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm'); // this row's first number input is Freq only in Fourier-spin mode
  await page.waitForTimeout(50);
  const { MAX_FREQ } = await getLimits(page);
  const freqInput = page.locator('#editor .editor-row').first().locator('input[type="number"]').first();
  await expect(freqInput).toBeVisible();
  await freqInput.fill('1000000');
  await freqInput.dispatchEvent('input');
  await freqInput.dispatchEvent('change');
  await page.waitForTimeout(100);

  const freq = await page.evaluate(() => window.fourierDemo.store.get().components[0].freq);
  expect(Number.isFinite(freq), `freq must be finite, got ${freq}`).toBe(true);
  expect(Math.abs(freq), `freq=1e6 input must be clamped to <= ${MAX_FREQ}, got ${freq}`).toBeLessThanOrEqual(MAX_FREQ);

  await page.click('#play');
  const frameDeltas = await page.evaluate(() => new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    let frames = 0;
    function tick(now) {
      deltas.push(now - last);
      last = now;
      frames += 1;
      if (frames < 30) requestAnimationFrame(tick);
      else resolve(deltas);
    }
    requestAnimationFrame(tick);
  }));
  const sorted = [...frameDeltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  expect(median, `median frame time was ${median}ms after a freq=1e6 input`).toBeLessThan(50);
});

test('editor: clicking a row selects it (.selected class)', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  const rows = page.locator('#editor .editor-row');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  const idx = count > 1 ? 1 : 0;
  const target = rows.nth(idx);
  await target.locator('.editor-swatch').click();
  await expect(target).toHaveClass(/selected/);
});

test('control tab: bandwidth B=2', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-control');
  await page.waitForTimeout(150);

  const bandwidth = page.locator('#bandwidth');
  await expect(bandwidth).toBeVisible();
  await bandwidth.fill('2');
  await bandwidth.dispatchEvent('input');
  await bandwidth.dispatchEvent('change');
  await page.waitForTimeout(100);
  expect(await bandwidth.inputValue()).toBe('2');

  await expect(page.locator('#joint-canvas')).toBeVisible();
  await page.screenshot({ path: path.join(SCREENS_DIR, 'control-bandwidth-2.png') });
});

test('perf smoke: 150 components keep median frame time under 20ms', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm'); // "150 components" is a Fourier-spin-mode scenario
  await page.waitForTimeout(150);

  const canvas = page.locator('#spectrum-canvas');
  const box = await canvas.boundingBox();
  expect(box, '#spectrum-canvas must have a bounding box').toBeTruthy();

  // Add 150 components via the documented "double-click empty space adds a
  // component" spectrum interaction (notes/plan.md WP2 contract), spreading
  // the double-clicks across the canvas so they land on empty space rather
  // than repeatedly hitting one existing stem.
  const targetCount = 150;
  for (let i = 0; i < targetCount; i++) {
    const x = box.x + 4 + (i % (box.width - 8));
    const y = box.y + box.height * 0.5;
    await page.mouse.dblclick(x, y);
  }
  await page.waitForTimeout(100);

  await page.click('#play');
  await page.waitForTimeout(200);

  const frameDeltas = await page.evaluate(() => {
    return new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      let frames = 0;
      function tick(now) {
        deltas.push(now - last);
        last = now;
        frames++;
        if (frames < 60) {
          requestAnimationFrame(tick);
        } else {
          resolve(deltas);
        }
      }
      requestAnimationFrame(tick);
    });
  });

  const sorted = [...frameDeltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  expect(median, `median frame time was ${median}ms with ~${targetCount} components`).toBeLessThan(20);
});

// ---------------------------------------------------------------------------
// Round-2 red-team fixes (notes/redteam/{r2-func,r2-math-text,fix-plan}.md)
// ---------------------------------------------------------------------------

async function noOverflow(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    document.querySelectorAll('#panel-arm *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), right: Math.round(r.right), vw });
      }
    });
    return out;
  });
}

test('mobile 390px: no element in the Arm panel is wider than the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await gotoApp(page);
  expect(errors).toEqual([]);
  await page.click('#tab-arm');
  await page.waitForTimeout(150);

  // Default (gesture mode: the per-joint editor with collapsible finger sections).
  const overflowingGesture = await noOverflow(page);
  expect(overflowingGesture, `elements wider than the viewport (gesture mode):\n${JSON.stringify(overflowingGesture, null, 2)}`).toEqual([]);
  await expect(page.locator('#panel-arm .caption').first()).toBeVisible();

  // Fourier-spin mode (Freq/Amp/Phase editor rows, Sort/Add buttons).
  await page.selectOption('#presets', 'arm');
  await page.waitForTimeout(150);
  const overflowing = await noOverflow(page);
  expect(overflowing, `elements wider than the viewport (spin mode):\n${JSON.stringify(overflowing, null, 2)}`).toEqual([]);

  // The Add button and captions must actually be visible once scrolled to,
  // not just narrower than the viewport (e.g. clipped by an ancestor's
  // overflow:hidden instead).
  const addBtn = page.locator('#add-component');
  await addBtn.scrollIntoViewIfNeeded();
  await expect(addBtn).toBeVisible();
  await expect(addBtn).toBeInViewport();
  await expect(page.locator('#panel-arm .caption').first()).toBeVisible();
});

test('editor: blur re-patches the freq input to the sanitized store value (1e6 -> MAX_FREQ)', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm');
  await page.waitForTimeout(50);
  const { MAX_FREQ } = await getLimits(page);
  const freqInput = page.locator('#editor .editor-row').first().locator('input[type="number"]').first();
  await freqInput.fill('1000000');
  await freqInput.dispatchEvent('input');
  await freqInput.blur();
  await page.waitForTimeout(100);

  expect(await freqInput.inputValue()).toBe(String(MAX_FREQ));
  const freq = await page.evaluate(() => window.fourierDemo.store.get().components[0].freq);
  expect(freq).toBe(MAX_FREQ);
});

test('editor: non-finite text (1e400) reverts to the current value on blur instead of going blank', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'arm');
  await page.waitForTimeout(50);
  const freqInput = page.locator('#editor .editor-row').first().locator('input[type="number"]').first();
  const before = await freqInput.inputValue();

  await freqInput.fill('1e400');
  await freqInput.dispatchEvent('input');
  await freqInput.blur();
  await page.waitForTimeout(100);

  expect(await freqInput.inputValue()).toBe(before);
  const freq = await page.evaluate(() => window.fourierDemo.store.get().components[0].freq);
  expect(Number.isFinite(freq), `freq must stay finite, got ${freq}`).toBe(true);
});

test('preset select shows "Custom" once a manual edit diverges from the chosen preset', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');

  await page.selectOption('#presets', 'circle');
  await page.waitForTimeout(100);
  expect(await page.locator('#presets').inputValue()).toBe('circle');

  const freqInput = page.locator('#editor .editor-row').first().locator('input[type="number"]').first();
  const current = parseFloat(await freqInput.inputValue());
  await freqInput.fill(String(current + 1));
  await freqInput.dispatchEvent('input');
  await page.waitForTimeout(100);

  expect(await page.locator('#presets').inputValue()).toBe('custom');
});

test('skin checkbox is disabled (with a tooltip) for a non-anatomical preset', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  const skin = page.locator('#skin-toggle');
  // Default preset is the human arm: anatomical, so enabled.
  expect(await skin.isDisabled()).toBe(false);

  await page.selectOption('#presets', 'circle');
  await page.waitForTimeout(100);
  expect(await skin.isDisabled()).toBe(true);
  const title = await skin.getAttribute('title');
  expect(title && title.length > 0, 'disabled skin checkbox must have an explanatory tooltip').toBeTruthy();

  await page.selectOption('#presets', 'arm');
  await page.waitForTimeout(100);
  expect(await skin.isDisabled()).toBe(false);
});

test('control tab: toggling actuator lag visibly changes the theta panel', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-control');
  await page.waitForTimeout(200);

  const before = await page.locator('#joint-canvas').screenshot();
  await page.check('#feedback-toggle');
  await page.waitForTimeout(200);
  const after = await page.locator('#joint-canvas').screenshot();

  expect(Buffer.compare(before, after), 'theta panel pixels must change when actuator lag is toggled on').not.toBe(0);
});

test('draw mode: Send to Arm at K=max reproduces the drawn path', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-draw');
  await page.waitForTimeout(150);
  await drawStarOnCanvas(page);
  await expectFiniteCoeffs(page);

  const kSlider = page.locator('#k-slider');
  const maxPos = await page.evaluate(() => Number(document.getElementById('k-slider').max) || 1000);
  await kSlider.fill(String(maxPos));
  await kSlider.dispatchEvent('input');
  await page.waitForTimeout(100);
  expect(await page.locator('#k-value').textContent()).toBe(String(K_MAX));

  const coeffs = await page.evaluate(() => window.fourierDemo.store.get().drawing.coeffs);

  await page.click('#send-to-arm');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.fourierDemo.store.get().mode)).toBe('arm');

  const armPath = await page.evaluate(() => Array.from(window.fourierDemo.store.derived().path));
  const M = armPath.length / 2;

  // At K=max every non-DC coefficient survives (plus DC), so the arm's
  // reconstruction should closely match the ORIGINAL drawing's own full-coeff
  // IDFT (sum is order-independent, so this is exactly what Send-to-Arm's
  // topKWithDC(coeffs, K_MAX) produced) sampled at the same resolution.
  let sumSq = 0;
  for (let n = 0; n < M; n += 1) {
    const t = n / M;
    const recon = idftEval(coeffs, t);
    const dx = recon.re - armPath[2 * n];
    const dy = recon.im - armPath[2 * n + 1];
    sumSq += dx * dx + dy * dy;
  }
  const rms = Math.sqrt(sumSq / M);
  expect(rms, `RMS between drawn path and Send-to-Arm(K=max) arm path was ${rms}`).toBeLessThan(0.01);
});

// ---------------------------------------------------------------------------
// Gesture mode: articulated arm+hand (default preset), pick-up-a-ball, joint
// dragging, and Control-tab bandwidth freezing.
// ---------------------------------------------------------------------------

/** Sample armView.gestureJointsPx() at N evenly-spaced times over one period. */
async function sampleGestureJoints(page, view, n = 16) {
  return page.evaluate(async ({ viewName, n: count }) => {
    const { store } = window.fourierDemo;
    const v = window.fourierDemo[viewName];
    store.set({ playing: false }, 'test');
    const out = [];
    for (let i = 0; i <= count; i += 1) {
      store.setTime(i / count);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      out.push(v.gestureJointsPx());
    }
    return out;
  }, { viewName: view, n });
}

test('gesture: default preset is "wave hello" with a fully articulated 5-finger hand', async ({ page }) => {
  const errors = await gotoApp(page);
  expect(errors).toEqual([]);
  await page.click('#tab-arm');
  expect(await page.locator('#presets').inputValue()).toBe('wave');
  expect(await page.evaluate(() => window.fourierDemo.store.get().motion)).toBe('gesture');

  const first = await page.evaluate(() => window.fourierDemo.armView.gestureJointsPx());
  const fingers = ['thumb', 'index', 'middle', 'ring', 'little'];
  for (const name of fingers) {
    for (const j of [1, 2, 3]) expect(first).toHaveProperty(`${name}${j}`);
  }
  for (const id of ['upperArm', 'forearm', 'palm']) expect(first).toHaveProperty(id);
  expect(Object.keys(first).length).toBe(18); // 3 main + 5 x 3 finger joints

  const samples = await sampleGestureJoints(page, 'armView');
  const xs = samples.map((s) => s.middle3.x);
  expect(Math.max(...xs) - Math.min(...xs), 'fingertip x must visibly oscillate over the period').toBeGreaterThan(5);
});

test('gesture: elbow relative angle stays within a human-ish range across the wave', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  const maxAbsDeg = await page.evaluate(() => {
    const { store } = window.fourierDemo;
    const bones = store.get().gesture.bones;
    const forearm = bones.find((b) => b.id === 'forearm');
    let maxAbs = 0;
    for (let i = 0; i <= 100; i += 1) {
      const t = i / 100;
      let v = forearm.series.mean;
      for (const h of forearm.series.harmonics) v += h.amp * Math.cos(2 * Math.PI * h.h * t + h.phase);
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    return maxAbs * (180 / Math.PI);
  });
  expect(maxAbsDeg).toBeLessThan(170);
});

test('gesture: dragging a joint on the arm changes that joint\'s mean angle (rotate-only)', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  const box = await page.locator('#arm-canvas').boundingBox();
  await page.evaluate(() => window.fourierDemo.store.set({ playing: false }, 'test'));
  await page.waitForTimeout(150);

  const before = await page.evaluate(() => {
    const b = window.fourierDemo.store.get().gesture.bones.find((x) => x.id === 'forearm');
    return b.series.mean;
  });
  const joints = await page.evaluate(() => window.fourierDemo.armView.gestureJointsPx());
  const forearmPx = joints.forearm;
  const upperArmPx = joints.upperArm;

  await page.mouse.move(box.x + forearmPx.x, box.y + forearmPx.y);
  await page.mouse.down();
  // Drag perpendicular to the upperArm->forearm segment, a good distance,
  // to guarantee a real rotation rather than a sub-pixel nudge.
  const dx = forearmPx.x - upperArmPx.x;
  const dy = forearmPx.y - upperArmPx.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  await page.mouse.move(box.x + forearmPx.x + nx * 60, box.y + forearmPx.y + ny * 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  const after = await page.evaluate(() => {
    const b = window.fourierDemo.store.get().gesture.bones.find((x) => x.id === 'forearm');
    return b.series.mean;
  });
  expect(Math.abs(after - before), `mean angle must change from a drag: before=${before} after=${after}`).toBeGreaterThan(0.05);
});

test('gesture: pick-up-a-ball preset lifts the ball off the table during the grasp, then returns it to rest', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.selectOption('#presets', 'pickup');
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.fourierDemo.store.get().gesture.kind)).toBe('pickup');

  const { attachedCount, maxRise, restPos } = await page.evaluate(() => {
    const { store, gesture } = window.fourierDemo;
    const bones = store.get().gesture.bones;
    let attachedCount = 0;
    let maxRise = -Infinity;
    for (let i = 0; i <= 200; i += 1) {
      const t = i / 200;
      const st = gesture.pickupBallState(bones, t);
      if (st.attached) {
        attachedCount += 1;
        maxRise = Math.max(maxRise, st.pos.im - gesture.PICKUP.tableY);
      }
    }
    const restSt = gesture.pickupBallState(bones, 0);
    return { attachedCount, maxRise, restPos: restSt.pos };
  });
  expect(attachedCount, 'the ball must be attached (grasped) for some portion of the period').toBeGreaterThan(0);
  expect(maxRise, 'the ball must visibly rise above the table while grasped').toBeGreaterThan(0.02);
  const pickup = await page.evaluate(() => window.fourierDemo.gesture.PICKUP);
  expect(restPos.re).toBeCloseTo(pickup.ballRestX, 6);
  expect(restPos.im).toBeCloseTo(pickup.tableY, 6);
});

test('gesture: Control tab bandwidth B=0 freezes the arm at its mean pose', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-control');
  await page.waitForTimeout(150);

  const bandwidth = page.locator('#bandwidth');
  await bandwidth.fill('0');
  await bandwidth.dispatchEvent('input');
  await page.waitForTimeout(100);

  // The (non-interactive) Control-arm view eases its autofit scale/center
  // toward the current bbox every frame rather than snapping instantly, so
  // give it time to fully converge before comparing — otherwise a residual
  // few px of unconverged easing (not an unfrozen pose) would fail the check.
  const posAt = async (t) => {
    await page.evaluate((tt) => window.fourierDemo.store.setTime(tt), t);
    await page.waitForTimeout(500);
    return page.evaluate(() => window.fourierDemo.controlArmView.gestureJointsPx());
  };
  const p0 = await posAt(0);
  const p1 = await posAt(0.5);
  for (const id of Object.keys(p0)) {
    // A couple of px of residual autofit easing (not a real pose change) is
    // tolerated; the wave/pickup presets swing joints by tens of px at this
    // scale, so this threshold clearly distinguishes "frozen" from "moving".
    expect(Math.abs(p1[id].x - p0[id].x), `${id}.x must be frozen at B=0`).toBeLessThan(2);
    expect(Math.abs(p1[id].y - p0[id].y), `${id}.y must be frozen at B=0`).toBeLessThan(2);
  }
});
