# Round-1 fix plan (2026-09-23). Findings: notes/redteam/{text-quality,math,appearance,functionality}.md

Five fixers run IN PARALLEL on ONE working tree. Edit ONLY your own files. No git commits (orchestrator commits).
Test servers: use your own port (A 8131, B 8132, C 8133, D 8134, E 8135); kill when done. Scratch files only in
/private/tmp/claude-501/-Users-jmanning-fourier-control-theory/9d9e027a-5e1f-48f4-83ae-64721d098215/scratchpad/fix-<letter>/.
Other agents' files may change under you mid-run; if something of theirs looks broken, report it, don't fix it.

## Cross-cutting contracts (everyone relies on these)
- E adds to js/core/store.js: exported `MAX_FREQ = 64`, `MAX_AMP = 5`, and `sanitizeComponent(c)`:
  freq → Math.round, clamped to [−MAX_FREQ, MAX_FREQ]; amp → finite, clamped to [0, MAX_AMP] (NaN → 0);
  phase → finite (NaN → 0), wrapped to (−π, π]. Applied inside withIds / updateComponent / addComponent / setComponents / set({components}).
  Views and editor may import MAX_FREQ/MAX_AMP.
- Skin is drawn only for the anatomical arm: B implements `isAnatomical(components)` = every component has a `label` string,
  exported from js/ui/armSkin.js; armView draws skin iff (opts.skin ?? state.showSkin) && isAnatomical(components).
  Skin-mode drag semantics (plain = rotate only; shift = length too) apply only when skin is actually drawn.
- Phase-on-stem gesture changes from shift+drag to **alt/option+drag** (and the ring handle, and wheel). **Shift-drop = merge** only.
  C implements; D and E update captions/tutorial accordingly.
- Wheel over spectrum changes phase only when the spectrum canvas has focus AND a stem is selected AND pointer over that stem's head/ring; otherwise page scrolls.
- armView pauses time advance while a joint is being dragged: set a flag via store.set({dragging: true|false}, 'arm');
  app.js rAF loop (D) must not advance t while state.dragging is true.
- armView/spectrumView keep exposing jointsPx() / stemHeads(); window.fourierDemo stays.

## Owners
- A: js/ui/drawView.js, tests/e2e/**, playwright.config.js
- B: js/ui/armView.js, js/ui/armSkin.js, js/ui/canvas.js
- C: js/ui/spectrumView.js
- D: index.html, css/theme.css, css/app.css, js/app.js, js/ui/editor.js, js/ui/jointPlot.js
- E: js/core/*.js, tests/unit/**, content/tutorial.html, README.md
