### K: A linked repository's copy shows a status that does not stand

Status: Fixed in #195.

Seen: on a linked board, a member who is not a card's owner edits its status line to `Ready`. The
board keeps the card in Open and says who tried, but after the next copy, `docs/roadmap.md` in the
repository lists the card under `## Ready`, with the status line as that member wrote it. The
same goes for a card a member deleted without being its owner: the copy leaves it out.

Cause: the agent builds the copy in `agent/plugin.ts` from each section's newest revision, which
`GET /docs/:id` gives. The page reads the status that stands from every member's word, through
`GET /docs/:id/words` and `standing` in `client/src/board.ts`, which the agent does not have.

Fix: `cardSections`, `cardOf`, `cardsOf`, `standing`, `reviewsOf`, `usernamesOf` and what they use
moved from `client/src/board.ts` to `shared/board.ts`, so the page and the agent run one rule. The
agent reads the Roadmap through `GET /docs/:id/words`, with the project's members and usernames from
its check-in, and copies each card's text that stands. A card whose removal did not stand stays in
the copy. A change of members makes a new copy, since it can change which statuses stand. Proposals
and claims read the same cards, and a proposal still hashes the text as written.
