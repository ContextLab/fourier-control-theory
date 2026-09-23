# Red-team round 1: text / code quality / utility (2026-09-23)
1. editor.js:173 early-return on source==='editor' skips updateSelection; row click (:106) never highlights. Fix: handle selectedId before early return.
2. drawView.js:45 preloaded heart upside-down (double y flip). Fix {x,y}.
3. Skin drawn for every preset + Control arm (circle = flesh blob). Fix: skin only when components carry labels (arm preset) — or equivalently only for the arm preset.
4. tutorial.html:32-35 & §3.3 (:275-280): drag text wrong (Control arm not interactive; skin-mode plain drag rotates only). Fix wording; Arm tab only.
5. §1.5 (:126-130) Gibbs wrong: paths continuous closed curves -> corners are kinks, no 9% overshoot; coefficients ~1/f^2. Reword (Gibbs requires jump; mention a pen-lift / non-closed drawing creates a jump at the closing segment? no—closing segment is continuous too).
6. "Bode plot" (jointPlot.js:179, index.html:172) actually plots |c_f|; no |H(f)| curve when lag on. Overlay |H(f)|, relabel "Spectrum |c_f|".
7. README 28-29 claims abs+rel angles; plot shows only abs. Add q_k toggle (plan had it) or fix README.
8. §3.2 (:267) remove "Draw mode's top-K selection restricted to low frequencies" (top-K by amplitude).
9. Document Delete/Backspace in spectrum; shift-drag phase conflicts with shift-drop merge (resolve: e.g. alt-drag = phase, shift-drop = merge); Draw caption must say press Draw first (or better: allow drawing directly).
10. §3 table mixes c_k/c_f; 28 em-dashes; filler "genuinely useful","literally","exactly".
11. Dead code: kToSlider, setDrawing (drawView.js:32,124); stale id-stamping workarounds app.js:50-61, drawView.js:12-20 (store withIds does it now); dead preset('arm') try/catch app.js:63-72; PALETTE defined 3x.
12. Passband rgba(16,185,129,.15) unthemed; canvas fonts sans-serif not theme font; fc slider enabled when lag off; B ignored when lag on (make both apply or disable clearly).
13. Canvases lack role/aria-label; no keyboard control of joints/stems.
14. Tabs lack aria-controls / arrow-key support.
15. Contrast fails dark: Send-to-Arm 2.15, active tab 2.63, captions 3.75, editor headers 3.07 (light 2.45).
Utility: play/scrub on Control tab; "sort by |f|" button; linked highlight arm<->stem; guided exercises per section; |H(f)| overlay + lagged-vs-target overlay; slider for number of preset terms.
Passed: links 200, KaTeX no raw $, no console errors, no 390px h-scroll, README table matches.
