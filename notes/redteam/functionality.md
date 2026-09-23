# Red-team round 1: functionality/usability (2026-09-23). Screens in scratchpad/redteam-func/
1 CRIT draw NaN (same). Send to Arm loads 50 NaN comps.
2 HIGH arm drag unbounded: skin off/shift, drag off-canvas -> amp=370; autofit shrinks others ungrabbable.
3 HIGH spectrum freq runaway: dragging stem to right edge keeps increasing freq (131, 420) since x-range grows under pointer. Freeze F during drag + clamp.
4 HIGH editor accepts freq=1e6 -> 2M ticks/frame, 666ms frames.
5 MED x-axis labels vanish (non-integer eased F).
6 MED shift double duty: shift+vertical on shared-freq stem merges on release instead of phase only.
7 MED drag while playing: joint drifts 40-170px from pointer; pause/hold during drag.
8 MED Draw discoverability: needs Draw click, disarms each stroke, no live ink, old heart stays; heart upside down; draw leaves playback paused.
9 LOW: editor shows rejected values (amp -0.5 stored 0, freq 2.6 stored 3); phase slider pins ±180 while stored unwrapped (720° = 4π); wheel over spectrum hijacks page scroll when selected; cursor ns-resize though horizontal drag works; hover cursor not updated while arm moves; captions omit dblclick add/Delete/shift-drop/wheel/phase ring; no tooltips; lag on ignores B; fc not disabled when lag off; B=0 tracking error "—"; trail draws straight line from old shape on preset change; skin on non-arm presets; removing selected row leaves stale selectedId; empty state no hint; abs/rel & wrapped/unwrapped controls don't exist.
Worked: theme persistence, no overflow 390, 150 comps & K=512 60fps, touch drags, all joints grabbable.
