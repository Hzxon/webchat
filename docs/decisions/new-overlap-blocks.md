### D: Two runs never hold the same file at once

Status: Proposed 2026-11-17 by the owner (docs/roadmap/new-overlap-gate.md).

A run declares the files it will change, and an overlap with a running card's files blocks it: the
run waits, and the two card owners choose to wait, stack or fold the cards. The draft with the
lower number keeps the file. A check in CI holds a session outside WebChat to the same rule
(docs/roadmap/new-overlap-ci.md). A change to a shared contract, such as a type, a migration or a
signed field, is its own card that lands first, and the cards that use it wait for it
(docs/roadmap/new-after-edge.md). No agent manages the other agents: the rule is in the board and
in CI, so it holds when every laptop is off. It changes D-116, where a conflict is a warning that
blocks nothing; that stays so for every conflict but this one. Why: a clash found after a merge
costs a person's review, and a run that waits costs only time.

Cost: two cards in one area run in a row, not at once. A footprint guessed too wide blocks others.
