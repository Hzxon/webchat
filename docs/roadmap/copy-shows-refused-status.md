### K: A linked repository's copy shows a status that does not stand

Status: Open. Found on 2026-11-12 in the review of #189.

Seen: on a linked board, a member who is not a card's owner edits its status line to `Ready`. The
board keeps the card in Open and says who tried, but after the next copy, `docs/roadmap.md` in the
repository lists the card under `## Ready`, with the status line as that member wrote it. The
same goes for a card a member deleted without being its owner: the copy leaves it out.

Cause: the agent builds the copy in `agent/plugin.ts` from each section's newest revision, which
`GET /docs/:id` gives. The page reads the status that stands from every member's word, through
`GET /docs/:id/words` and `standing` in `client/src/board.ts`, which the agent does not have.

Fix: the agent reads the board through the words route and the same `standing` and `cardOf`, moved
to `shared/board.ts` so both sides run one rule, and copies each card's text that stands.
