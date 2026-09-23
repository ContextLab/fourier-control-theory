# Fourier ⟷ Control Theory

An interactive, in-browser demo showing that a robot arm whose joints spin at constant
rates is a Fourier series, and vice versa: each link's length is a Fourier component's
amplitude, its constant spin rate is the component's frequency, and its starting angle is
the component's phase. Drag the arm and watch the spectrum update; drag the spectrum and
watch the arm move; draw a shape freehand and watch it get rebuilt out of spinning links.

By default, though, the arm does something a constant spin rate can't: it's a fully
articulated human arm and 5-fingered hand whose joints each follow their own short, periodic
Fourier series, waving hello or reaching down to pick up a ball. That "gesture mode" and the
original constant-spin-rate "Fourier-spin mode" are two motions of the same arm, switchable
from the Preset menu — see the tutorial's §4 for how a joint's periodic trajectory is still a
Fourier series, just no longer linear in time.

Live site: **https://context-lab.com/fourier-control-theory/**

No build step: plain HTML, CSS, and ES modules, rendered on `<canvas>`.

## Features

- **Arm tab** — an animated arm/hand next to its spectrum, in one of two motions (picked
  from the Preset menu):
  - **Gesture mode** (default) — a fully articulated human arm and hand: 3 main joints
    (shoulder/upper-arm, elbow, wrist/palm) plus 5 separate fingers of 3 joints each (18
    joints total), each following a short, periodic Fourier series in its own *relative*
    angle, `q(t) = mean + Σ aₕ·cos(2πht + ψₕ)` (`H ≤ 4`). Presets: "wave hello" and "pick up
    ball" (a ball rests on a drawn table; the hand grasps it — fingertips close, near the
    ball — carries it, and sets it back down, on a seamless loop). Dragging any joint
    rotates its *mean* angle only; the oscillation continues around the new mean, and
    everything downstream (the whole hand, for a main-chain joint) follows. The spectrum
    view shows the *joint-angle* spectrum (one group of stems per joint, in degrees) for
    whichever joint is selected, draggable for amplitude/phase; the editor shows per-joint
    mean+harmonic rows, fingers grouped into collapsible sections.
  - **Fourier-spin mode** ("Fourier spin" preset, or any shape preset) — the original
    picture: 5 components are the bones (upper arm, forearm, hand, finger, fingertip), each
    spinning at a constant rate; a vector metallic "shell" deforms around them (shell only
    renders for presets whose components carry bone labels). A plain drag rotates a bone
    (its length stays fixed and the joint follows the pointer's direction); shift-drag also
    changes its length, landing the joint exactly under the pointer. With the shell toggled
    off, a plain drag does the full move (length and phase together). The hand is still
    drawn as 5 separate articulated fingers, but only the index finger's 2 bones (the
    "Finger"/"Fingertip" components) are real Fourier data; the other 4 fingers mirror its
    curl.

  The Control tab shows the same arm/hand as a read-only, bandwidth/lag-filtered display;
  drag joints on the Arm tab. Drag a spectrum stem vertically to change its amplitude,
  horizontally to change its frequency (snapped to the nearest integer, spin mode only).
  Hold Alt/Option while dragging, drag the phase ring around a selected stem's head, or
  scroll the wheel over it, to change phase instead. Double-click empty space to add a
  component, shift-drop one stem onto another at the same frequency to merge them, or
  select a stem and press Delete/Backspace to remove it (all spin-mode-only).
- **Draw tab** — sketch a closed shape freehand directly on the canvas. The app resamples
  it by arc length, runs a discrete Fourier transform, and animates the reconstruction as
  spinning epicycles, in the style of 3Blue1Brown's Fourier-series animations. A `K` slider
  controls how many of the strongest components (by amplitude, not frequency) are kept, so
  you can watch the sketch resolve as `K` grows.
- **Control tab** — the same arm relabeled in control-theory terms: joint-angle traces with
  toggles for absolute vs. relative (motor) angle and wrapped vs. unwrapped phase, a
  bandwidth slider that truncates the series to a low-pass approximation, and a
  feedback-lag toggle that applies a first-order lag filter `H(f) = 1 / (1 + i f / f_c)` to
  every component; both the bandwidth limit and the lag filter apply together, and the arm
  and joint-angle traces shown are the *filtered* arm. A spectrum panel plots `|c_f|` with
  the retained passband shaded and always overlays `|H(f)|`, whether or not the lag toggle
  is on. In gesture mode, `B` and the lag filter apply per-harmonic to each joint's own
  series instead (`B = 0` freezes the arm at its mean pose), and the theta panel plots the
  3 main joints' actual angles — this is also where the "pick up ball" grasp can visibly
  fail once the reach is filtered away too far.
- **Component editor** — an explicit list of components (frequency, amplitude, phase) with
  add/remove controls and shape presets (human arm, circle, ellipse, square wave, sawtooth,
  star, heart). Every component's frequency and amplitude are clamped to a safe range
  (`MAX_FREQ` = 256 cycles/period, `MAX_AMP` = 5, both in `js/core/store.js`), so a stray
  drag or a typed-in value can't produce a runaway animation.
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

The page exposes `window.fourierDemo = { store, armView, spectrumView, controlArmView,
gesture: { pickupBallState, PICKUP } }`. The end-to-end tests use it to find where joints and
spectrum stems are drawn (`armView.jointsPx()`, `armView.gestureJointsPx()` — all 18 gesture
joints by id — `spectrumView.stemHeads()`), then drag them with the real mouse. It's also
handy in the browser console, e.g. `fourierDemo.store.get().gesture.bones` or
`fourierDemo.store.get().components`.

## Code architecture

| File | Purpose |
|-|-|
| `index.html` | Page shell: header, the Arm/Draw/Control tabs, the tutorial section, KaTeX and Font Awesome from CDN |
| `css/theme.css` | CSS custom properties for the light/dark theme, base styles, buttons, cards, nav |
| `css/app.css` | Layout grid, canvas sizing, sliders, the component editor list, tab styling |
| `js/app.js` | Bootstraps the store, wires up the tabs, theme toggle, and presets menu, runs the single `requestAnimationFrame` loop, loads the tutorial |
| `js/core/complex.js` | Pure complex-number arithmetic: add, sub, mul, scale, abs, arg, `e^{i\theta}` |
| `js/core/fourier.js` | Pure Fourier math: arc-length resampling, DFT, inverse evaluation, top-K selection, low-pass filtering |
| `js/core/arm.js` | Pure arm kinematics: joint positions, joint angles (absolute and relative), drag inversion, path sampling |
| `js/core/gesture.js` | Pure gesture kinematics: the 18-joint arm+hand bone tree, forward kinematics, joint-angle Fourier series (`evalSeries`), the "wave hello"/"pick up ball" presets, the pick-up-ball object logic, and the Control tab's per-joint bandwidth/lag filter |
| `js/core/presets.js` | Shape presets (human arm, circle, ellipse, square, sawtooth, star, heart) expressed as component lists; drops a shape's near-zero DC term so it doesn't waste a requested component slot |
| `js/core/store.js` | Application state, subscriptions, a lazily-recomputed derived cache, and `sanitizeComponent()`, which clamps every component's freq/amp/phase on every add/update — no DOM code |
| `js/ui/canvas.js` | HiDPI canvas setup and world-to-pixel coordinate transforms |
| `js/ui/armView.js` | Renders the arm/epicycles/trace (both motions) and handles joint dragging (including gesture mode's rotate-the-mean drag); draws the pick-up-ball table/ball; exposes `jointsPx()` and `gestureJointsPx()` |
| `js/ui/armSkin.js` | Draws the metallic-shell arm+hand: the 3-bone main chain plus 5 separate real finger chains, one continuous brushed-steel gradient, blended at each joint |
| `js/ui/spectrumView.js` | Renders the stem plot and handles stem dragging (amplitude, frequency, phase) |
| `js/ui/drawView.js` | Freehand capture and the epicycle reconstruction animation |
| `js/ui/jointPlot.js` | Joint-angle-vs-time plot (filtered arm, both motions) and the control-theory overlays (bandwidth, lag filter, spectrum panel with `|H(f)|` overlay) |
| `js/ui/editor.js` | Spin mode's component list UI (add/remove, numeric inputs) and gesture mode's per-joint mean+harmonic rows (fingers grouped into collapsible sections) |
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
