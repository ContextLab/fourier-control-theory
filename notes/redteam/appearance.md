# Red-team round 1: appearance (2026-09-23). Screens in scratchpad/redteam-appearance/
HIGH
1. Draw freehand NaN (same as math #1).
2. Arm too small (15-25% canvas width), off-centre (upper middle). At 1280x720 canvas starts y≈540 — nothing above fold. Fit view to path bbox (+arm reach); shrink hero padding/gap (~150px wasted).
3. Skin over a period: elbow bends both ways/folds >150°, forearm over upper arm with both outlines visible (translucent overlap); shoulder is unoutlined translucent blob behind pivot; hand small stub w/ thumb nub; finger links bare lines; fingertip dot outside skin. Fix: single union path (draw opaque skin to offscreen or use one fill then outline), proper shoulder cap/torso, wider hand & fingers, soften extreme flexion in skin only.
MED
4. Scrubbing t leaves straight chords in trail — reset trail on time jumps / draw trail from analytic path.
5. Hero gradient green->blue; course uses green->dark green (#00693e->#005a34). Course theme toggle uses emoji (minor).
6. Captions low contrast (light #94a3b8 on #f8fafc 2.5:1; dark #64748b 3:1). Fix AA.
7. Control plots: raw labels, no axes/ticks; time cursor same orange as a trace; at B=8 passband covers whole plot.
8. Draw canvas lacks card/border; strokes without pressing Draw silently ignored (allow direct drawing).
9. Mobile 390: tutorial nested cards -> 250px text width. Arm layout 1440: big empty column under Components panel.
LOW
10. perf fine (16.7ms), no overflow, KaTeX ok.
11. 390px hero wraps "Robot / Arms"; editor footnote plain-text c·e^(i2πft) -> KaTeX.
