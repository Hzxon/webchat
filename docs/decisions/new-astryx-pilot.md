### D: The sign-in screen tries Astryx; every other screen keeps styles.css

Status: Proposed 2026-11-15 in #247 (docs/roadmap/new-astryx-pilot.md).

`AuthScreen` is built from Astryx components (`@astryxdesign/core` 0.7.16) under a runtime
theme, `client/src/astryxTheme.ts`, whose tokens point at D-083's variables, so the palette
still changes only in `styles.css`. `layers.css` puts `styles.css` in a cascade layer, `app`,
under Astryx's `astryx-base`: unlayered rules such as `button { color: inherit }` would beat
every Astryx component. Astryx's reset is left out, since it would change the screens that rely
on browser defaults. `App` loads the screen lazily, so only signed-out pages fetch Astryx.
Why: to judge Astryx's look, its accessibility and its cost on one real screen before moving any
other. Cost: the sign-in page loads 109 kB more JavaScript and 43 kB more CSS, gzipped; the
signed-in bundle is unchanged. `astryx init` adds a block to AGENTS.md whose rules hold only for
Astryx screens. Undo: revert #247.
