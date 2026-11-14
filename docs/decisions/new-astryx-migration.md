### D: The app runs on Astryx, under one theme and its reset

Status: Proposed 2026-11-15 in #248 (docs/roadmap/new-astryx-migration.md).

`main.tsx` wraps the app in Astryx's `Theme` with `webchatTheme`, whose tokens point at D-083's
variables, so the palette still changes only in `styles.css`. Astryx's reset is on, in the lowest
layer. `styles.css` sits above it and under Astryx's components (`layers.css`), and gives the
screens not yet moved the browser's heading sizes and list markers back. `overrides.css` sits in a layer above Astryx's, for the few row states no prop covers, such as
an urgent row. The sidebar points Astryx's surface tokens at its own tint again. Dialogs use Astryx's
`Dialog`, which keeps focus in, closes on Escape, and ignores a backdrop click once a field was used.
Astryx fields have no `maxLength` or native `required`, so the page cuts and checks values itself.
Why: Astryx components rely on its reset, and every screen moves next. Cost: every page now loads
Astryx's runtime, about 220 kB more JavaScript and 44 kB more CSS, gzipped. Supersedes the pilot's
lazy loading and its "reset left out".
