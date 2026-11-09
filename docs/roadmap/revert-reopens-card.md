### K: A reverted run's card stays Done

Status: Open. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Seen: #159 fixed K-1 and #169 reverted it. Nothing tells the board. Once a run's draft merges, the
card says `Done in repo#N` or `Fixed in repo#N`, and the plugin stops watching (D-118). A revert
then leaves a finished card for work that main no longer has. The team only learns of it by hand.

Fix: the owner's agent already lists open pull requests for a linked board (`sendClaims` in
`agent/plugin.ts`). It also looks at merged ones whose body says `Reverts` or `This reverts commit`
of a pull request a finished card names. The owner's page then sets that card back to `Open` with a
line that names the revert, under its lock, as it does for other moves.

Done when: a merged revert of a card's pull request reopens the card, and a test proves it.
