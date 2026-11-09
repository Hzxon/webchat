### K: A card stays In review after its run's draft is closed unmerged

Status: Fixed in #171.

Seen: a card run's draft that the owner closes without merging leaves the card at
`In review: repo#N` for good. Teammates read the status line as the run's state (D-100), so the card
looks taken, and the brief refuses it to everyone else (K-59).

Cause: the plugin reported a close as `ended`, the same as watching that stops on an open draft,
and `client/src/runStatus.ts` had no move for `ended`.

Fix: the plugin reports `closed` when the draft closes unmerged. The owner's page moves the card
from `In review: repo#N` back to the status it had before the run, as it does when a run fails.
`statusMove` in `client/src/board.ts` now holds every move, so a test covers them.

Done when: the agent test sees `closed` for a closed draft, and the board test sees the move.
