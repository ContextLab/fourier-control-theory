# 2026-09-23 handoff: r4-fixes

## Resume command

```bash
cd "/Users/jmanning/fourier-control-theory"
git stash push --message "before resuming 2026-09-23" || true
git checkout -B resume/r4-fixes 8dc7699b84d5bc91b92adcd3371303102d275dfc
```

## State

branch: wip/r4-fixes
commit: 8dc7699b84d5bc91b92adcd3371303102d275dfc
uncommitted work: none (the interrupted fixer's partial edits were committed to wip/r4-fixes and pushed to origin)

```
$ git status --porcelain
```

Deployed/live: `main` at 692a0e7e552c2b42a35d4525cdfb3edf7e4f0384 → https://context-lab.com/fourier-control-theory/ (GitHub Pages, Actions workflow `.github/workflows/pages.yml`, deploys on push to main only). `wip/r4-fixes` is 1 commit ahead of main and NOT deployed.

## Done and verified

- Full demo live (Arm / Draw / Control tabs, tutorial, course theme, README). Proved by `curl -s -o /dev/null -w "%{http_code}\n" https://context-lab.com/fourier-control-theory/js/core/gesture.js`, which printed `200`, after deploy run for 692a0e7 reported `completed success`.
- On main 692a0e7: `npm test` printed `# pass 97` / `# fail 0`; `npx playwright test` printed `31 passed (1.0m)`.
- Gesture mode (default "Human arm — wave hello", "— pick up ball", "— Fourier spin"), 18-joint hand with 5 separate 3-joint fingers on a palm, metallic shell: verified by my own 8-frame contact sheets (scratchpad sheet-wave.png, sheet-pickup2.png) and by the R4 live verifier ("PASSED: Hand: 5 separate fingers…; Wave reads as waving…; Pick-up reaches, grasps, lifts and sets the ball down; nothing goes below the table").
- On wip/r4-fixes 8dc7699: `npm test` printed `# pass 97` / `# fail 0` (run just before committing).

## Done but NOT verified

- wip/r4-fixes contains the interrupted fixer's partial work for the R4 list (see notes/redteam/r3.md context and the R4 list under Next): spectrumView.js gesture drag freeze/clamp + stemHeads in gesture mode (+79 lines), store.js updateJointHarmonic clamp (+33), armView.js framing (+39), jointPlot.js legend/colors (+31), gesture.js (+18), tutorial/README wording. The fixer's last message was "Let's reload and verify the legend fix:" — so the legend was mid-verification. Not verified: e2e suite, the new runaway e2e test (may not exist yet), screenshots.

## Broken

- (on live main 692a0e7) Gesture-mode spectrum harmonic stem drag runs away — reported by R4 verifier: "moving the forearm h=1 stem up in 2px steps gave 0.49, 0.51, 0.55 … 1.33, 1.65 rad, speeding up each step. Holding the pointer near the top for 40 moves reached 30234 rad". Possibly fixed on wip/r4-fixes (unverified).

```
(no automated test output — observed via Playwright real-mouse drag on the live site by the R4 verifier agent)
```

repro: open https://context-lab.com/fourier-control-theory/ (default wave preset), select the forearm joint, drag its h=1 stem in the spectrum canvas upward in small steps and hold near the top; watch the amplitude in the editor / the elbow spin.

## Dead ends

- Frequency/amplitude drags computed against an axis that auto-rescales from the dragged value run away (hit twice: spectrum freq drag round 1, gesture harmonic drag round 4). Freeze all axis scales at pointerdown + grab offset + store clamp. Do not compute drag value from a live-rescaling axis.
- Parallel fixers without explicit data-shape contracts broke seams ({re,im} vs {x,y} → NaN DFT; id-less components → remove deleted all). Keep one owner per file and state shapes in the contract (notes/redteam/fix-plan.md).
- Playwright `devices['Desktop Chrome']` overrides viewport to 1280×720; pin viewport explicitly (done in playwright.config.js).
- Per-frame autofit to the current pose causes zoom pumping; fit once to the whole-period envelope.

## Corrections to earlier notes

- `notes/2026-09-23-session.md` early lines say "Enable GitHub Pages … needs user OK". That is no longer true: Pages is enabled (build_type=workflow), live URL https://context-lab.com/fourier-control-theory/ (not contextlab.github.io).
- `notes/plan.md` says MAX_FREQ-free contracts and default preset 'star'/'arm'. That is no longer true: store.js exports MAX_FREQ=256, MAX_AMP=5; default is gesture "wave".

## Open decisions

None.

## Next

1. Resume on wip/r4-fixes (resume command above). Finish/verify the R4 fixes: (BLOCKING) gesture harmonic drag freeze+clamp with an e2e test proving linear, bounded response; (minor) tutorial §3.5 default-preset wording; README gesture spectrum = selected joint + stemHeads works in gesture mode; gesture spectrum hint not cut off; ball clearly visible while carried; framing includes shell half-width (wave shoulder touching bottom; Control arm at B=0 cropped left); Control joint plot per-joint colors + legend.
2. `npm test` and `npx playwright test` all green; LOOK at screenshots (wave/pickup sweeps, both themes, 390px).
3. Merge wip/r4-fixes into main (fast-forward), push, wait for Pages deploy success, confirm live.
4. Quick live re-check of the blocker (real-mouse drag).
5. Slack DM the user (@jeremy = Slack user WTBBT348Y, the user's own account) with the live link https://context-lab.com/fourier-control-theory/ — the user's standing request: "once all issues are addressed, message me (@jeremy) on slack with a link to the live demo".

## Watch out for

- Pushing to main deploys to the public site immediately; keep WIP on wip/ branches.
- Agents have left screenshots/.playwright-mcp in the repo root before; .gitignore now covers `.playwright-mcp/`, `fix-*/`, `tests/e2e/screens/`, but check `git status` before committing.
- The IDE's TypeScript diagnostics on plain-JS files (e.g. "Property 'fourierDemo' does not exist on type Window") are not test failures; ignore.
- Node 22 `node --test tests/unit/` (directory form) fails; use `npm test` (glob).
- A vim swap file `.README.md.swp` appeared earlier (user editing README?) — `*.swp` is gitignored; don't clobber the user's edits.
