# WebChat board kit: how to build with it

These are the parts of WebChat's project board: tinted lanes of white cards, the same lanes as a
list of rows, a card that opens in a wide dialog with two panes (the "peek"), and the panel that
shows a coding agent's run of a card. Everything is on `window.WebchatBoard`.

## Wrap everything in `BoardTheme`

Put one `BoardTheme` at the root of the page. It carries WebChat's palette and corners. Without
it the parts render with the component library's own blue accent and round corners.

```jsx
const { BoardTheme, BoardLanes, BoardLane, CardFace } = window.WebchatBoard;

<BoardTheme mode="light">
  <div style={{ display: 'flex', flexDirection: 'column', height: 420, background: 'var(--panel)' }}>
    <BoardLanes>
      <BoardLane name="Ready" kind="ready" count={1} add={[{ label: 'New idea', onSelect: add }]}>
        <CardFace id="R-40" title="Export a chat as a file" text="Download a chat as Markdown." owner={null}
          action={<button className="board-small-button" onClick={pick}>Pick</button>} onOpen={open} />
      </BoardLane>
      <BoardLane name="Running" kind="running" count={1}>
        <CardFace id="K-12" title="Drop bad push keys" owner={{ name: 'Ann Lee', seed: 1 }}
          chips={[{ tone: 'warn', label: 'Asking you' }]} pull={{ number: 214, state: 'draft' }} isWaiting onOpen={open} />
      </BoardLane>
    </BoardLanes>
  </div>
</BoardTheme>
```

Dark is `mode="dark"` on that one root `BoardTheme`. The palette belongs to the whole page, so
never nest a second `BoardTheme` to make one region dark.

## Which part for what

- A lane: `BoardLanes` > `BoardLane` > `CardFace`. `kind` picks the lane's icon: `idea` (dashed),
  `ready`, `running` (half filled, in the accent), `review`, `done` (a check) or `dropped`. `add`
  and `menu` are lists of menu entries for its + and ⋯; the finished lane takes `onHide` and
  `isFinished` instead.
- A folded lane in the header: `FoldChip`. A menu or, at phone width, a bottom sheet: `BoardMenu`.
- The List view: `BoardGroup` > `CardRow`, with the same props as a face but its text.
- A card's face takes `id`, `title`, three lines of `text`, `owner` (`{ name, seed }`, `null` for
  a dashed no-owner circle, left out for a decision), state `chips`, a `pull` mark, and an `action`
  such as Pick, which sits outside the button that opens the card. `isWaiting` tints a card whose
  agent asks the user amber, with a solid "Asking you" chip.
- A draft that is not a card yet: `ProposalFace` (dashed).
- State chips: `StateChip` with `tone` `warn | danger | muted`. Only the agent's question and a
  failure have a color. A pull request: `PullNumber` with `state` `draft | review | merged`.
- An opened card: `CardPeek` with `id`, `title`, `tools` (a list of `{ label, icon, onClick }`:
  History and Delete card), `facts` (pairs of a name and a value) and the card's text as children,
  usually `<Markdown text="..." />`. The left pane starts with a Preview and Edit switch: pass
  `isEditing` (required) and `onEditing`, and render the card's editor as the children while it is
  on. `editOff="reason"` turns the switch off.
- The right pane is the agent's run: pass `run={<RunPanel ...>}`. Its head names the agent and
  when it started; its children are `RunStep`s; its `footer`, pinned at the foot, holds `RunAsk`
  (the agent's question) and the reply box. With no `run`, the pane says no agent works on the
  card, and `onRun` adds a button (`runLabel` names it).
- At phone width the peek fills the screen: Close at the left, the tools behind ⋯ in a sheet, the
  run under the card and the question pinned at the foot.
- People: `Face` with `person` (`{ name, seed }`) and `size` (20 in a fact, 22 on a card, 26 in the header): initials on a soft tint, round. Icons: `HistoryIcon`, `TrashIcon`,
  `PencilIcon`, `PlayIcon`, `StopIcon`, `FileIcon`, each with `width` and `height`.

`CardPeek` is a modal dialog: it covers the page while it is rendered, so render it only for the
card that is open.

## Styling your own layout

Controls come from the kit. For layout glue, use plain elements with inline styles and WebChat's
CSS variables, never hex colors or new class names:

| Use | Variables |
| --- | --- |
| Surfaces | `--bg` (page), `--panel` (panels and dialogs), `--lane` (a lane and the run pane), `--card` (a card), `--hover` |
| Lines and text | `--line`, `--text`, `--muted` |
| Accent | `--accent`, `--accent-strong`, `--accent-soft`, `--on-accent` |
| States | `--ok`, `--ok-soft`, `--warn`, `--warn-soft`, `--danger`, `--danger-soft` |
| Shape | `--radius` for buttons and fields; lanes round at 12px, cards at 10px |

Panels are flat with a 1px `var(--line)` border. Only dialogs and menus cast a shadow. One orange accent;
success is `--ok`, never the accent.

A few class names from the app are safe to reuse inside these parts:

- `board-card-run`: a row of small buttons or a muted line under a card's facts.
- `board-small-button`: a small outlined button on a face, such as Pick.
- `agents-ended`: a `Banner` with its buttons on one line, in a `RunPanel` footer.
- `doc-note`: a short muted remark.

## Words

Sentence case, short plain sentences, no exclamation marks. Card ids read `R-12` (an idea),
`K-7` (an issue), `D-12` (a decision). Lanes are Idea, Ready, Running and In review; Done is the
finished lane, which shows only when asked for.

## Where the truth lives

Read `styles.css` and the `_ds_bundle.css` it imports for the real variables and classes, and each
part's `.prompt.md` and `.d.ts` under `components/general/<Name>/` for its props and examples.
