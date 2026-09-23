# Implementation plan (from Plan subagent, 2026-09-23). Contracts below are FROZEN.

Theming source: /Users/jmanning/llm-course/demos/shared/css/demo-styles.css and demos/attention/index.html
(fixed `.demo-nav` with round `.theme-toggle`, `.hero-header` with green-gradient title, `.controls-panel`,
`.card`, system font stack, `data-theme` on `<html>` default "dark", persisted in localStorage key `theme`).

## 1. File layout (repo root = site root, no build step)
```
index.html              header, 3 tabs (Arm | Draw | Control), tutorial section, KaTeX + Font Awesome from CDN
css/theme.css           course :root + [data-theme=light] variables, base, .btn, .card, .demo-nav, .hero-*
css/app.css             layout grid, canvases, sliders, editor list, tabs
js/app.js               bootstrap, store wiring, single rAF loop, tabs, theme toggle, loads tutorial
js/core/complex.js      pure: add, sub, mul, scale, abs, arg, expi, fromPolar
js/core/fourier.js      pure: resampleArcLength, dft, idftEval, topK, sampleSeries, lowpass
js/core/arm.js          pure: jointPositions, jointAngles, invertDrag, pathSamples
js/core/presets.js      pure: preset(name, n) -> components[]
js/core/store.js        state + subscribe/notify, derived cache (no DOM)
js/ui/canvas.js         HiDPI canvas helper, world<->pixel transform
js/ui/armView.js        arm, epicycles, trace, joint dragging
js/ui/spectrumView.js   stem plot + stem dragging
js/ui/drawView.js       freehand capture + 3B1B-style animation
js/ui/jointPlot.js      θ_k(t) plot + control-theory overlays (bandwidth, lag filter, mini Bode)
js/ui/editor.js         component list, add/remove, numeric inputs, presets menu
content/tutorial.html   HTML fragment with KaTeX-delimited math ($…$, $$…$$)
tests/unit/*.test.js    node --test
tests/e2e/screens.spec.js  Playwright
package.json            {"type":"module", scripts: test, test:e2e, serve}; devDep @playwright/test
.github/workflows/pages.yml  unit tests, then deploy with actions/deploy-pages
README.md
```

## 2. Pure math (complex = {re, im}; t ∈ [0,1) is one period)
- complex.js: expi(θ), add, sub, mul, scale(z,s), abs, arg, fromPolar(r,φ).
- fourier.js
  - resampleArcLength(pts:{x,y}[], N=512, closed=true) -> {re,im}[] (close with p_{M-1}→p_0, drop duplicate
    consecutive points, cumulative length, s_n = nL/N, binary search + linear interp; always N points).
  - dft(z) -> {freq, c}[] for f = −N/2..N/2−1, c_f = (1/N) Σ z_n e^{−i2π f n/N}; O(N²) with cos/sin table.
  - idftEval(coeffs, t) = Σ c_f e^{i2π f t}.
  - topK(coeffs, K): sort by |c| desc (DC f=0 first always), take K.
  - sampleSeries(components, M=1000) -> Float32Array(2M) (x0,y0,x1,y1,...).
  - lowpass(coeffs, fc): c_f · H(f), H(f) = 1/(1 + i f/fc). Accepts {freq,c}[] and returns same shape.
  - component ↔ coefficient: c = amp·e^{iφ}. Export toCoeff(component) and fromCoeff({freq,c}, extra).
- arm.js (components = [{id,freq,amp,phase,color}], chained in array order)
  - jointPositions(components, t, origin={re:0,im:0}) -> {re,im}[] length n+1; p_k = p_{k−1} + amp_k e^{i(2π f_k t+φ_k)}.
  - jointAngles(components, t) -> {abs:number[], rel:number[]}; abs θ_k = φ_k + 2π f_k t (unwrapped);
    rel q_k = θ_k − θ_{k−1}, θ_0 ≡ 0.
  - invertDrag(components, k, P, t, origin) -> {amp, phase}: w = (P − p_{k−1}(t))·e^{−i2π f_k t}; amp=|w|,
    phase=arg w; if amp<1e-6 keep previous phase. (k is 0-based index into components; p_{k−1} is the base of link k.)
  - pathSamples(components, M=1000) = sampleSeries.
- presets.js: preset(name, n=15) for 'circle','ellipse','square','sawtooth','star','heart' (+ export PRESET_NAMES).
  star/heart via parametric curve → resampleArcLength → dft → topK(n). Normalize so Σ amp = 1.
  Components returned without ids/colors is fine (store assigns them).

## 3. Store (js/core/store.js)
```js
state = { components, t, playing, speed, mode:'arm'|'draw'|'control', selectedId, yScale:'amp'|'power',
  showCircles, K, bandwidth, drawing:{ raw:[], coeffs:[], active:false } }
createStore(initial) -> { get(), set(patch, source), setTime(t), updateComponent(id, patch, source),
  addComponent(partial) -> id, removeComponent(id), setComponents(list, source), subscribe(fn, keys?) -> unsubscribe,
  derived() -> { path: Float32Array, spectrum: Map<freq,{sum:{re,im}, ids:[]}> } }
```
Subscribers get (state, changedKeys:Set, source). Keys filter. derived() lazily recomputed only when components
changed (dirty flag). setTime does NOT notify (rAF loop renders canvases every frame). New components get next
color from palette #267aba #ffa00f #a5d75f #8a6996 #d94415 #f5dc69 #c4dd88 #9d162e; ids from counter.

## 4. Spectrum view
x: integer freqs −F..F, F = max(|f|)+3 (min 5), eased rescale. y: amp or power (1.15× max, frozen during drag).
Stems colored per component; head circle with phase tick at angle φ. Hit test nearest head ≤10px else stem |Δx|<6px.
Drag vertical = amp (power mode: amp=√y); horizontal = freq=round(x) with eased snap. Phase: ring handle (r=16px)
around selected head, drag → φ=atan2; alt/shift+vertical 100px=2π; wheel fine steps. Duplicate freqs allowed:
drawn at ±0.18 offsets, faint wide bar = |Σc| "combined"; shift-drop merges c=c1+c2. Dbl-click empty adds component;
Delete removes selected. selectedId shared.

## 5. Draw mode
Draw → pointer capture records points (skip <2px moves) → on up close curve → resampleArcLength(512) → dft → sort
(DC first) → drawing.coeffs → components = topK(coeffs,K) (default 50; #k-slider 1..512 log-ish, re-slice only).
Animation: links in descending amplitude, faint circles (single beginPath), vector lines, fading ring-buffer trace
of last period, original dashed at 25% opacity, optional follow-tip zoom camera. RMS reconstruction error readout.
"Send to Arm" button. One period ≈10 s at 1×: t += dt·speed/10.

## 6. Control tab (jointPlot.js)
Second armView instance (joints numbered); θ_k(t) plot (wrapped/unwrapped, abs/rel toggle, time cursor, link colors);
task vs joint space: target path, tip tracking with only |f| ≤ B (#bandwidth slider) → rounded corners, error readout;
mini Bode: gray |c_f|, passband shaded green, captured energy fraction; optional feedback toggle: first-order lag
H(f)=1/(1+i f/f_c) applied to coeffs (attenuation + phase lag → shape shrinks and rotates).

## 7. Work packages
- WP1 core+unit tests: js/core/*.js, tests/unit/*.test.js, package.json.
- WP2 canvas views: js/ui/canvas.js, armView.js, spectrumView.js.
  createArmView(canvas, store, {interactive:true, showTrace:true, showCircles, numberJoints, componentsOverride?})
  -> {render(state, derived), resize(), destroy()}; createSpectrumView(canvas, store, opts) same shape.
  canvas.js: setupCanvas(canvas) -> {ctx, w, h, dpr} (live getter object updated by ResizeObserver),
  makeTransform(center, scale) -> {toPx(z), toWorld(x,y)}. Colors from CSS vars; re-read on document 'themechange'.
- WP3 shell + other views: index.html, css/theme.css, css/app.css, js/app.js, js/ui/editor.js, drawView.js, jointPlot.js.
  Tutorial fetched from content/tutorial.html into #tutorial then KaTeX renderMathInElement.
  Theme toggle sets data-theme, localStorage 'theme', dispatches 'themechange' on document.
  DOM ids: #arm-canvas #spectrum-canvas #draw-canvas #joint-canvas #editor #tab-arm #tab-draw #tab-control
  #theme-toggle #play #time #speed #k-slider #yscale-toggle #bandwidth #tutorial.
- WP4 content+infra: content/tutorial.html, README.md, .github/workflows/pages.yml, tests/e2e/screens.spec.js.
- Integration (orchestrator): unit tests, serve, Playwright, inspect screenshots, fix.

## 8. Tests
Unit: DFT→idft roundtrip; pure tone; linearity; Parseval; resampling spacing & N; jointPositions end == idftEval;
invertDrag (p_k==P, downstream shifted by same Δ, upstream unchanged, identity roundtrip); jointAngles slope;
topK order; lowpass |H(fc)|=1/√2; store notify filter, lazy derived, removeComponent.
E2E (chromium 1400×900, both themes): screenshots per mode; joint drag changes editor values; stem drag changes amp;
draw a heart, K=5 and K=100; control tab B=2; `.katex` count >10; fail on console.error; perf: 150 components,
median frame <20 ms. Screens → tests/e2e/screens/ (gitignored).
