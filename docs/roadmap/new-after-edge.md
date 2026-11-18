### R: A card waits for the cards it names

Status: Done in #277. Proposed 2026-11-17 by the owner, from the parallel work design. Needs the decision
in docs/decisions/new-overlap-blocks.md.

Order: beside the overlap gate (docs/roadmap/new-overlap-gate.md): this card touches the board, and
that one the run.

Why: two changes can merge clean and still break the build, when one changes a shared contract and
the other was written against the old one: a type in `shared/types.ts`, a migration, the sync
fingerprint in `db.stamp`, a field bound into the signature. No file overlap shows it. The order
has to be on the board before either card runs, and today a card can say it only in prose, as
"Order:" lines do.

Scope:

- A card's body may hold an `After: K-12, R-30` line. `shared/board.ts` reads it as it reads
  `Checked:`.
- A card whose `After:` names a card that is not Done or Fixed cannot be picked. Its face names
  the cards it waits for. The plugin refuses to run it, as it refuses a claimed card (D-118).
- When the last card it waits for is done, the card can be picked, and its run starts from a main
  that has that work.
- The agent's check of a draft (D-116) proposes the split: a card that changes a contract and uses
  it becomes a small contract card and a card `After:` it. The owner adds both or declines.
- A card named in `After:` that was dropped shows as a warning on the waiting card, whose owner
  removes the line or drops the card.

Constraints: pages hold the gate, since the server cannot read a card, and the line is part of the
card's signed text (D-081). The repository copy keeps the line (D-117). A loop of `After:` lines
shows as a warning on each card in it and blocks them all.

Done when: a card that waits cannot be picked or run, and can once the card it names is Done; the
check of a draft that changes a contract proposes two cards; a loop and a dropped card each show a
warning; a test covers each; and the board shows it at 375 pixels, in light and dark mode.
