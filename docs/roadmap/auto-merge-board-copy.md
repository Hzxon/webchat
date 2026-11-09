### R: The board's copy merges without the owner

Status: Idea. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Why: main lags the board until the owner merges the `agent/board` pull request (D-117). Each sync
is one more chore for the owner. Sessions read the repository's copy, so a late merge sends them to
stale cards. The first copy (#170) changed 2,300 lines of `docs/decisions.md`, too much to review
by eye, so a review adds little.

Scope: the agent asks GitHub to merge `agent/board` once its checks pass, with
`gh pr merge --auto --squash`. CI already fails a pull request whose copy anyone else edits, and the
branch changes only the two copies and the proposal files the owner added. The owner can switch it
off on the board. This changes D-117, so the owner decides it first.

Done when: a board change reaches main with no click from the owner, and a pull request that
touches anything else on `agent/board` waits for them.
