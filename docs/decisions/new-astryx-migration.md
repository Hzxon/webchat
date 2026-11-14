### D: The app runs on Astryx, under one theme and its reset

Status: Proposed 2026-11-15 in #248 (docs/roadmap/new-astryx-migration.md).

Every screen builds its controls from Astryx components under `webchatTheme`, whose tokens point at
D-083's variables. `layers.css` orders the cascade: Astryx's reset, `styles.css`, Astryx's
components, then `overrides.css`, the few states no prop covers. Astryx fields have no `maxLength`
or native `required`, so the page cuts values and checks empty fields itself. Message bubbles, the
reaction tray, board cards and doc sections keep their own markup: their scroll, paging, quote and
reaction rules (D-029, D-030, D-109) have no Astryx match. Why: one reference for people and agents
building UI, and 1,250 fewer lines of CSS. Cost: every page loads Astryx's runtime, about 210 kB
more JavaScript and 41 kB more CSS, gzipped.
