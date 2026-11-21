# Notes for the next design system sync

WebChat is an app, not a component library. The design system holds the project board's parts,
built as a small library in `design/board-kit/`. Read this before a re-sync.

## How to build

- `npm ci`, then `npm run build:board-kit`. It writes `design/board-kit/dist/`: `index.js`,
  `style.css` and the types under `dist/types/`.
- The converter runs from the repository root:
  `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./design/board-kit/dist/index.js --out ./ds-bundle`
- The render check and the capture use the Chrome on the machine, not a downloaded Chromium:
  install `playwright` in `.ds-sync/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and set
  `DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

## What the library is

- `design/board-kit/src/index.ts` re-exports the app's own components from `client/src/components/`.
  Only `BoardTheme` is written in the kit: it wraps Astryx's `Theme` with the app's `webchatTheme`
  and sets `data-theme` on the page, as `client/src/main.tsx` and `colorMode.ts` do.
- The stylesheet is the app's whole CSS (`client/src/layers.css`) plus Astryx's, in the app's
  order. So the bundle's CSS also holds chat and sidebar rules the board's parts do not use.
- Seven icons are exported for use inside the parts but left out of the component list
  (`componentSrcMap` sets them to `null`).
- The four Astryx controls in the list (`Banner`, `Button`, `IconButton`, `Text`) are the ones the
  board's parts are built with. Astryx's other components are not in this design system.

## Previews

- All 18 components have authored previews in `.design-sync/previews/`, graded good.
- `cfg.provider` is `BoardTheme`, so every preview renders in the light palette.
- The dark palette is page-wide (`:root[data-theme='dark']`), and the preview's own wrapper sets
  light after any inner `BoardTheme`. So no preview shows dark. Do not add a "Dark" cell: it
  renders light.
- `CardPeek` is a modal dialog: its card is `cardMode: single` with a 1280x760 viewport.
- Ten components use `cardMode: column`, because their previews are wider than a grid cell.

## Known render warns

- `[RENDER_THIN] ... rendered height is 0px` on all 18 components. Astryx's `Theme` root, the
  first child of every preview's mount, has `display: contents`, so it measures 0 pixels high
  while its children render. The sheets and the contact sheets show every card rendered.
- `[TOKENS_MISSING] 53 CSS custom properties`: Astryx sets these at runtime on its components.

## Re-sync risks

- The parts are the app's components. A change to `BoardParts.tsx`, `CardPeek.tsx`,
  `RunPanel.tsx`, `PullTags.tsx`, `Avatar.tsx` or `Markdown.tsx` changes the design system at the
  next sync: rebuild the kit and re-run the driver.
- `.design-sync/conventions.md` names CSS variables and three class names
  (`board-card-run`, `agents-ended`, `doc-note`). Check them against the bundle's CSS if
  `client/src/styles/` changes.
- A pull request that makes every card open in two panels was in progress when this sync ran
  (branch `claude/peek-two-panels`). It changes `CardPeek`: re-sync after it lands, and update the
  `CardPeek` preview.
- Not verified: the dark palette in a preview, and how the cards look in Claude Design itself.
