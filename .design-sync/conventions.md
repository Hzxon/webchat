# WebChat board kit: how to build with it

These are the parts of WebChat's project board: a board of roadmap cards in lanes, a card that
opens in a wide dialog (the "peek"), and the panel that shows a coding agent's run of a card.
Everything is on `window.WebchatBoard`.

## Wrap everything in `BoardTheme`

Put one `BoardTheme` at the root of the page. It carries WebChat's palette and corners. Without
it the parts render with the component library's own blue accent and round corners.

```jsx
const { BoardTheme, BoardLanes, BoardLane, CardFace, NeedsRow, Button } = window.WebchatBoard;

<BoardTheme mode="light">
  <NeedsRow items={[{ key: 'r12', label: 'R-12 Search in channels', reason: 'Asking you', onOpen }]} />
  <BoardLanes>
    <BoardLane name="Ready" count={1}>
      <CardFace title="Export a chat as a file" owner={{ name: 'Ann Lee', seed: 1 }}
        action={<Button size="sm" label="Pick" onClick={pick} />} onOpen={open} />
    </BoardLane>
    <BoardLane name="Running" count={1}>
      <CardFace title="Search in channels" owner={{ name: 'Ann Lee', seed: 1 }} status="Ann's agent"
        tag={{ tone: 'warn', label: 'Asking you' }} isWaiting onOpen={open} />
    </BoardLane>
  </BoardLanes>
</BoardTheme>
```

Dark is `mode="dark"` on that one root `BoardTheme`. The palette belongs to the whole page, so
never nest a second `BoardTheme` to make one region dark.

## Which part for what

- A lane: `BoardLanes` > `BoardLane` > `CardFace`. A folding list under the lanes (Open, Done, a
  group of decisions): `BoardDrawer`.
- A Roadmap card's face takes `owner` (`{ name, seed }`, or `null` for no owner). A decision's
  face takes `id` and no `owner`.
- A draft that is not a card yet: `ProposalFace` (dashed).
- What waits for the user, above the lanes: `NeedsRow`.
- An opened card: `CardPeek` with `id`, `title`, `tools` (`IconButton`s), `facts` (pairs of a
  name and a value) and the card's text as children, usually `<Markdown text="..." />`.
- A run beside the card: pass `run={<RunPanel ...>}` to `CardPeek`. Its children are `RunStep`s;
  its `footer` holds `RunAsk` (the agent's question) or a `Banner` with `Button`s.
- People: `Avatar` (`size` 20 in a fact, 24 on a face). States: `Tag` with `tone`
  `ok | warn | danger | info | muted`; its child is one plain string.
- Icons: `PencilIcon`, `HistoryIcon`, `PlayIcon`, `StopIcon`, `TrashIcon`, `BellIcon`, `FileIcon`,
  each with `width` and `height` (18 in an `IconButton`).

`CardPeek` is a modal dialog: it covers the page while it is rendered, so render it only for the
card that is open.

## Styling your own layout

Controls come from the kit. For layout glue, use plain elements with inline styles and WebChat's
CSS variables, never hex colors or new class names:

| Use | Variables |
| --- | --- |
| Surfaces | `--bg` (page), `--panel` (panels and dialogs), `--chat-bg` (the run panel), `--hover` |
| Lines and text | `--line`, `--text`, `--muted` |
| Accent | `--accent`, `--accent-strong`, `--accent-soft`, `--on-accent` |
| States | `--ok`, `--ok-soft`, `--warn`, `--warn-soft`, `--danger`, `--danger-soft` |
| Shape | `--radius` for every corner |

Panels are flat with a 1px `var(--line)` border. Only dialogs cast a shadow. One orange accent;
success is `--ok`, never the accent.

A few class names from the app are safe to reuse inside these parts:

- `board-card-run`: a row of small buttons or a muted line under a card's facts.
- `agents-ended`: a `Banner` with its buttons on one line, in a `RunPanel` footer.
- `doc-note`: a short muted remark.

## Words

Sentence case, short plain sentences, no exclamation marks. Card ids read `R-12` (an idea),
`K-7` (an issue), `D-12` (a decision). Lanes are Ready, Running and In review; drawers are Open
and Done.

## Where the truth lives

Read `styles.css` and the `_ds_bundle.css` it imports for the real variables and classes, and each
part's `.prompt.md` and `.d.ts` under `components/general/<Name>/` for its props and examples.
