# Fourier ⟷ Control Theory

An interactive, in-browser demo showing that a robot arm whose joints spin at constant
rates is a Fourier series, and vice versa: each link's length is a Fourier component's
amplitude, its constant spin rate is the component's frequency, and its starting angle is
the component's phase. Drag the arm and watch the spectrum update; drag the spectrum and
watch the arm move; draw a shape freehand and watch it get rebuilt out of spinning links.

Live site: **https://context-lab.com/fourier-control-theory/**

No build step: plain HTML, CSS, and ES modules, rendered on `<canvas>`.

## Features

- **Arm tab** — an animated chain of links (the "puppet") next to its amplitude/power
  spectrum. By default the chain is drawn as a human arm: the five components are the
  bones (upper arm, forearm, hand, finger, fingertip) and a vector "skin" deforms around
  them at the shoulder, elbow, wrist, and knuckles. Drag any joint and that bone rotates
  while everything further out follows rigidly; shift-drag to change the bone's length
  (its amplitude) as well. With the skin toggled off, a plain drag changes both.
  Drag a spectrum stem vertically to change its amplitude, horizontally to change its
  frequency, or use the phase ring to change its phase. Double-click empty space in the
  spectrum to add a component; shift-drop one stem onto another to merge them.
- **Draw tab** — sketch a closed shape freehand. The app resamples it by arc length, runs a
  discrete Fourier transform, and animates the reconstruction as spinning epicycles, in the
  style of 3Blue1Brown's Fourier-series animations. A `K` slider controls how many of the
  strongest components are kept, so you can watch the sketch resolve as `K` grows.
- **Control tab** — the same arm relabeled in control-theory terms: joint-angle traces (both
  absolute and relative/motor angle), a bandwidth slider that truncates the series to a
  low-pass approximation, and a feedback-lag toggle that applies a first-order lag filter
  `H(f) = 1 / (1 + i f / f_c)` to every component.
- **Component editor** — an explicit list of components (frequency, amplitude, phase) with
  add/remove controls and shape presets (human arm, circle, ellipse, square wave, sawtooth,
  star, heart).
- **Tutorial** — a written walkthrough (rendered with KaTeX) of the Fourier-analysis math,
  the control-theory background, and the correspondence between them.
- Light/dark theme toggle, HiDPI canvases, and pointer events that work with touch.

## Running locally

No install is required to view the site; it's static files served over HTTP (opening
`index.html` directly via `file://` will not work, since ES modules and `fetch` require a
server):

```sh
python3 -m http.server
```

Then open `http://localhost:8000/`.

## Tests

Unit tests cover the math core (DFT/inverse, arc-length resampling, arm kinematics, drag
inversion) with `node`'s built-in test runner, no build step required:

```sh
npm test
```

End-to-end tests drive a real Chromium browser with Playwright, covering each tab, joint and
spectrum dragging, the draw-and-reconstruct flow, the control tab, and a console-error check:

```sh
npm install
npx playwright install chromium
npm run test:e2e
```

The page exposes `window.fourierDemo = { store, armView, spectrumView }`. The end-to-end
tests use it to find where joints and spectrum stems are drawn (`armView.jointsPx()`,
`spectrumView.stemHeads()`), then drag them with the real mouse. It's also handy in the
browser console, e.g. `fourierDemo.store.get().components`.

## Code architecture

| File | Purpose |
|-|-|
| `index.html` | Page shell: header, the Arm/Draw/Control tabs, the tutorial section, KaTeX and Font Awesome from CDN |
| `css/theme.css` | CSS custom properties for the light/dark theme, base styles, buttons, cards, nav |
| `css/app.css` | Layout grid, canvas sizing, sliders, the component editor list, tab styling |
| `js/app.js` | Bootstraps the store, wires up the tabs and theme toggle, runs the single `requestAnimationFrame` loop, loads the tutorial |
| `js/core/complex.js` | Pure complex-number arithmetic: add, sub, mul, scale, abs, arg, `e^{i\theta}` |
| `js/core/fourier.js` | Pure Fourier math: arc-length resampling, DFT, inverse evaluation, top-K selection, low-pass filtering |
| `js/core/arm.js` | Pure arm kinematics: joint positions, joint angles (absolute and relative), drag inversion, path sampling |
| `js/core/presets.js` | Shape presets (human arm, circle, ellipse, square, sawtooth, star, heart) expressed as component lists |
| `js/core/store.js` | Application state, subscriptions, and a lazily-recomputed derived cache — no DOM code |
| `js/ui/canvas.js` | HiDPI canvas setup and world-to-pixel coordinate transforms |
| `js/ui/armView.js` | Renders the arm/epicycles/trace and handles joint dragging; exposes `jointsPx()` |
| `js/ui/armSkin.js` | Draws the anatomical arm: one continuous skin outline built around the bone chain, blended at each joint |
| `js/ui/spectrumView.js` | Renders the stem plot and handles stem dragging (amplitude, frequency, phase) |
| `js/ui/drawView.js` | Freehand capture and the epicycle reconstruction animation |
| `js/ui/jointPlot.js` | Joint-angle-vs-time plot and the control-theory overlays (bandwidth, lag filter, mini Bode plot) |
| `js/ui/editor.js` | The component list UI: add/remove, numeric inputs, presets menu |
| `content/tutorial.html` | The tutorial text, fetched into the page and rendered with KaTeX |
| `tests/unit/*.test.js` | Node built-in test runner tests for the math core |
| `tests/e2e/screens.spec.js` | Playwright end-to-end tests |

**Data flow:** every user interaction (a drag, a slider, an added component) calls a method
on the store in `js/core/store.js`, which updates its state and notifies subscribers. Each
view in `js/ui/` subscribes to the store and re-reads its `derived()` output (the sampled
path and the per-frequency spectrum, recomputed only when the component list changes) on
every animation frame. Nothing in `js/core/` touches the DOM, so the math is testable on its
own with `node --test`, independent of rendering.

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` runs on every push to `main`: it runs the unit
tests, then publishes the repository root as a GitHub Pages artifact and deploys it. To
enable it for the first time, turn on Pages for this repository (Settings → Pages → Source:
GitHub Actions); after that, every push to `main` that passes the unit tests redeploys the
site automatically.

## Theming

The color palette, typography, and navigation/card styling are adapted from the
[ContextLab LLM course](https://context-lab.com/llm-course/) demo pages, credit to the
Contextual Dynamics Laboratory.

## License

MIT — see [LICENSE](LICENSE).
