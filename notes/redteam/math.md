# Red-team round 1: math correctness (2026-09-23). Scripts in scratchpad/redteam-math/
CRITICAL
1. drawView.js:144,154 freehand draw broken: toWorld() returns {re,im} but rawWorldPts consumed as p.x/p.y -> NaN coeffs, blank canvas, RMS NaN. Fix push {x:world.re,y:world.im}. e2e draw test (screens.spec.js:220) never clicks #draw-start so doesn't capture; K slider value 5 -> K=1 not 5. Test must be fixed to really draw + assert finite RMS & nonempty coeffs.
HIGH
2. Gibbs claim wrong (tutorial 123-130, :270): closed continuous paths, uniform convergence; measured square overshoot 1.8% K=5, 0.15% K=151.
3. spectrumView.js:161-171 freq-axis labels vanish after preset change: eased L.F non-integer so f % labelStep never 0. Fix loop f from ceil(-F) to floor(F).
MEDIUM
4. README 28-29 abs+rel angles, only abs plotted.
5. mini Bode shows only |c_f|; no |H(f)| or filtered bars when lag on.
6. drawView.js:45 example heart flipped.
7. tutorial 34-35, §3.3 275-287: drag lands joint at P — not in skin mode (phase only; ~68px off). Document.
8. tutorial:32 drags in every tab — Control arm non-interactive.
LOW
- presets.js:145 topK keeps DC -> square/sawtooth/star waste a slot on zero-length f=0 link (fix: drop zero-amp DC in presets / topK option).
- tutorial:57 "unit-rate rotation" -> unit-magnitude.
- tutorial:137 say conjugate pairs c_{-f} = conj(c_f) for real signals.
- editor.js:173 row click no highlight.
PASSED: DFT vs numpy, Parseval, idft, lowpass -3dB/-45°, resample, jointPositions/angles/invertDrag, spectrum aggregation, presets shapes, power=amp², phase tick CCW, y-up consistent, deg<->rad, bandwidth energy, θ slopes, tutorial core formulas.
