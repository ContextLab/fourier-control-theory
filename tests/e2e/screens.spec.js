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

test('dragging a joint tip changes editor values', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.waitForTimeout(150);

  const canvas = page.locator('#arm-canvas');
  const box = await canvas.boundingBox();
  expect(box, '#arm-canvas must have a bounding box').toBeTruthy();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const before = await allEditorNumbers(page);
  expect(before.length, '#editor should list at least one numeric input').toBeGreaterThan(0);

  // Probe a small grid of plausible joint-tip offsets from the arm's origin
  // (world origin is conventionally mapped to canvas center per plan.md's
  // makeTransform(center, scale)).
  const offsets = [
    [60, 0], [0, 60], [-60, 0], [0, -60],
    [90, 40], [-90, 40], [90, -40], [-90, -40],
    [120, 0], [0, 120],
  ];

  let changed = false;
  for (const [dx, dy] of offsets) {
    const sx = cx + dx;
    const sy = cy + dy;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 25, sy + 15, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const after = await allEditorNumbers(page);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      changed = true;
      break;
    }
  }

  expect(changed, 'dragging the arm canvas at every probed offset left #editor values unchanged').toBe(true);
});

test('dragging a spectrum stem changes an editor amplitude value', async ({ page }) => {
  await gotoApp(page);
  await page.click('#tab-arm');
  await page.waitForTimeout(150);

  const canvas = page.locator('#spectrum-canvas');
  const box = await canvas.boundingBox();
  expect(box, '#spectrum-canvas must have a bounding box').toBeTruthy();
  const cx = box.x + box.width / 2;
  const bottomish = box.y + box.height * 0.7;

  const before = await allEditorNumbers(page);
  expect(before.length, '#editor should list at least one numeric input').toBeGreaterThan(0);

  // Probe a handful of x-offsets (integer-frequency stems near DC) and drag
  // vertically (amplitude) at each.
  const xOffsets = [0, 20, -20, 40, -40, 60, -60];
  let changed = false;
  for (const dx of xOffsets) {
    const sx = cx + dx;
    await page.mouse.move(sx, bottomish);
    await page.mouse.down();
    await page.mouse.move(sx, bottomish - 60, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const after = await allEditorNumbers(page);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      changed = true;
      break;
    }
  }

  expect(changed, 'dragging the spectrum canvas at every probed x-offset left #editor values unchanged').toBe(true);
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
