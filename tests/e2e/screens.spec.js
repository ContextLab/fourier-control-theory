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

test('no console errors across a full interaction pass', async ({ page }) => {
  const errors = await collectErrors(page, async () => {
    await page.goto('/index.html');
    await page.waitForSelector('#tab-arm', { timeout: 10_000 });
    for (const tabName of TABS) {
      await page.click(`#tab-${tabName}`);
      await page.waitForTimeout(100);
    }
    await page.click('#theme-toggle');
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

test('draw mode: freehand heart-ish shape, then K=5 and K=100', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-draw');
  await page.waitForTimeout(150);

  const canvas = page.locator('#draw-canvas');
  const box = await canvas.boundingBox();
  expect(box, '#draw-canvas must have a bounding box').toBeTruthy();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // A rough heart-like closed path: two lobes up top, a point at the bottom.
  const scale = Math.min(box.width, box.height) / 4;
  const heart = [
    [0, -0.3], [-0.4, -0.9], [-0.9, -0.6], [-1.0, -0.1], [-0.5, 0.5],
    [0, 1.0], [0.5, 0.5], [1.0, -0.1], [0.9, -0.6], [0.4, -0.9], [0, -0.3],
  ].map(([x, y]) => [cx + x * scale, cy + y * scale]);

  await page.mouse.move(heart[0][0], heart[0][1]);
  await page.mouse.down();
  for (const [x, y] of heart.slice(1)) {
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
  await page.waitForTimeout(150);

  const kSlider = page.locator('#k-slider');
  await expect(kSlider).toBeVisible();

  await kSlider.fill('5');
  await kSlider.dispatchEvent('input');
  await kSlider.dispatchEvent('change');
  await page.waitForTimeout(100);
  expect(await kSlider.inputValue()).toBe('5');
  await page.screenshot({ path: path.join(SCREENS_DIR, 'draw-heart-k5.png') });

  await kSlider.fill('100');
  await kSlider.dispatchEvent('input');
  await kSlider.dispatchEvent('change');
  await page.waitForTimeout(100);
  expect(await kSlider.inputValue()).toBe('100');
  await page.screenshot({ path: path.join(SCREENS_DIR, 'draw-heart-k100.png') });
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
