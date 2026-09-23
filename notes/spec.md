# Spec: Fourier ⟷ Control Theory interactive demo (2026-09-23)

Standalone static site for GitHub Pages (no build step; vanilla ES modules, Canvas 2D). Repo root = site root (`index.html`).

## Core idea
A planar robot arm with N revolute joints. Link k has length r_k and spins at an integer
frequency f_k with phase φ_k: joint position p_k(t) = Σ_{j≤k} r_j e^{i(2π f_j t + φ_j)}.
The end effector traces z(t) = Σ c_k e^{i2π f_k t}, i.e. a complex Fourier series. Each link is a
"component": radius = amplitude |c_k|, angle at t=0 = phase φ_k, spin rate = frequency f_k.
(User's phrasing "radius = frequency" is loose; in the UI: link length = amplitude, spin rate = frequency,
angle = phase. Explain this mapping explicitly in the tutorial.)

## Features
1. **Arm view (puppet)**: animated chain of links/joints (epicycles, optional faint circles), end effector
   trace drawn as a fading path. Play/pause, speed, scrub time slider.
2. **Drag joints**: dragging joint k's tip changes link k's amplitude + phase (in the rotating frame at the
   current t, so the arm follows the pointer); downstream links stay attached (rigidly translated). Path +
   spectrum update live.
3. **Spectrum view**: stem plot of |c_k| (or power |c_k|²; toggle) vs frequency (negative and positive
   integer frequencies), plus phase indicated by color or small phase dial. Dragging a stem vertically
   changes amplitude; horizontal drag changes frequency (snaps to integers); some gesture (e.g. shift-drag
   or phase ring) changes phase. Arm + path update live.
4. **Component editor UI**: list of components (freq, amp, phase) with add/remove, numeric inputs, and
   presets (circle, ellipse, square wave, sawtooth, star, heart...).
5. **Freehand draw mode**: user draws a closed-ish curve; resample uniformly by arc length (e.g. 512 pts),
   compute DFT, keep top-K components sorted by amplitude (slider K), animate the epicycle drawing like
   3Blue1Brown's "But what is a Fourier series?" (https://www.youtube.com/watch?v=-qgreAUpPwM). Shows
   original drawing faintly beneath the reconstruction; K slider shows convergence.
6. **Control-theory link**: show joint-angle trajectories θ_k(t) (each linear in t for a pure component),
   and optionally a simple "tracking" view: target path vs. end effector; explain inverse kinematics vs
   Fourier decomposition (redundant arm, each joint a constant-velocity actuator), frequency response, bandwidth/
   low-pass truncation = limited actuator bandwidth.
7. **Tutorial**: sections on (a) Fourier series & DFT math, (b) control theory background (kinematics, joint
   space vs task space, feedback, frequency-domain thinking, Bode/bandwidth), (c) links between them. KaTeX
   for math (from cdn.jsdelivr.net).
8. **Theming**: match https://context-lab.com/llm-course/ — CSS variables from
   /Users/jmanning/llm-course/demos/shared/css/demo-styles.css (Dartmouth green #00693e, river blue #267aba,
   bonfire orange #ffa00f, dark slate bg #0f172a, surface #1e293b, light theme toggle via [data-theme]).
   Font Awesome from cdnjs. Copy needed fonts (Avenir) locally only if license permits; otherwise system stack
   as in the course CSS.
9. **Smoothness**: requestAnimationFrame, devicePixelRatio-aware canvases, pointer events (touch works),
   no layout thrash; 60fps with 100+ components.
10. README: project description, how to run locally, deploy to GH Pages, code architecture.

## Testing
- Node built-in test runner (`node --test`) for pure math (DFT/inverse, resampling, arm kinematics,
  drag inversion) — real computations, no mocks.
- Playwright (or Chrome) screenshots of each mode, manually inspected.
- GitHub Actions workflow to deploy Pages + run tests.
