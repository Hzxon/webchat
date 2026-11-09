### K: An agent's draft can give a card two status lines

Status: Fixed in #171.

Seen: K-1 in the board's first copy (#170) has `Status: In review: Hzxon/webchat#159.` and, under
it, `Status: Open. Found by the owner…`. Readers cannot tell which one holds, and a run moves only
the first.

Cause (inferred from the text): an agent's draft wrote its own status line at the top of its body.
`cardText` in `client/src/board.ts` put the board's status line above it, so the card had both.

Fix: `cardText` drops a status line that the body starts with. The K-1 card itself is fixed by the
change file `docs/roadmap/K-1.md`.

Done when: a board test builds a card from such a body and reads one status line.
