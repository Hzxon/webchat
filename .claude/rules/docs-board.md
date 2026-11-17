---
paths:
  - "server/api.ts"
  - "server/api/**"
  - "server/db.ts"
  - "server/db/**"
  - "client/src/chat.ts"
  - "client/src/docs.ts"
  - "client/src/docTemplates.ts"
  - "client/src/board.ts"
  - "client/src/components/**"
  - "shared/board.ts"
  - "agent/**"
  - "test/board.test.ts"
---
# Docs and the board

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- Docs exist only in a channel, keyed by #general; a revision is sealed under the `webchat/doc/v1` header binding chat, key id, author, doc and section (D-081).
- A section save needs its `doc_locks` lock, which lapses 2 minutes after the last check-in; doc versions and held locks are in the sync fingerprint (D-081, D-021).
- A board is two docs marked by a `board` field inside the sealed title; a card's number, title and status come from its first two lines, in the `docs/decisions.md` format; pages write `Ready` and `Running:`; `readCard` alone reads the older `Next` and `Planned` as `Ready` and `In progress` as `Running`, keeping the rest of the line, so no other code tests the old words (D-082, the board-lanes decision, proposed in #188).
- A card's opener is the author of its section's oldest revision, and only when that revision's sealed content says `opened`, which `addCard` alone writes (the board-lanes decision, proposed in #188).
- A card with an owner shows the newest member's revision whose status its author may set (`standing`), and only its owner's removal stands; Roadmap cards are read through `boardCards` and written through `rewriteCard` or `takeCard`, from the card's `text`, the text that stands; `written` is only for hashes (the card-owner decision, proposed in #189).
- A run, a claim or a take starts only where `startable` allows: a Ready card, an Open one with no owner, or the user's own pick (the card-owner decision, proposed in #189).
- A card changes owner only through `takeCard`, where `startable` allows (the card-owner decision, proposed in #189).
- A request on a card goes to the person asked as a message in the asker's direct chat with them, with a sealed `card` field, so it pushes only them (the card-notes decision, proposed in #189).
- A review verdict counts only while its reviewer's own newest revision holds the line and is newer than the owner's or the owner's repeats it, and an answer to a change only from the owner's (`reviewsOf`); moves, drafts, run reports and a hand edit keep the review lines that stand, the edit through `keepReviews` from the lines read under its lock, so only the buttons change a review; while a verdict stands, a word of anyone else's stands only in Open, as a merge, or with an In review status a verdict's word says (the card-review decision, proposed in #190).
- A page gives a new card its number only through `addCard` in `client/src/docs.ts`: under the lock of its column doc's `title` section, from the cards loaded under that lock, never from cards it loaded before (D-116).
- A draft's `related` ids are only ones the brief held: its cards, the decisions the team holds and the open pull requests the plugin listed; the page drops a card or decision it cannot find (D-116).
- Only the project's owner links its board: the link is the `repo` of the Roadmap doc's sealed title, and the page and the agent count it only when the owner wrote that title; the agent copies only boards of projects its owner owns, and one board per repository (D-117).
- A board's copy is `copyOf` in `shared/board.ts`, for Copy as Markdown and for the agent alike, of each Roadmap card's text that stands: the agent reads the Roadmap from `GET /docs/:id/words` through `cardsOf`, with the project's members now, as the page does; the agent pushes only `agent/board`, never forced, writing the two docs and removing the proposal files its owner added (D-117, D-092).
