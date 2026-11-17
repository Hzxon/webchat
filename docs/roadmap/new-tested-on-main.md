### Q: How does a pull request get tested on the main it lands on?

Status: Running. Raised 2026-11-17 from the parallel work design. The owner chose the second way
that day, and #262 set it in main's ruleset. The day's measurement is still open.

CI checks a pull request against the main it started from, and nothing checks it again after main
moves (D-076). The overlap gate (docs/roadmap/new-overlap-gate.md) and the wait edge
(docs/roadmap/new-after-edge.md) keep runs apart, but nothing proves they did: two pull requests
that clash in a way neither sees still pass and both merge. D-076 records that GitHub's merge
queue needs a repository an organization owns.

The ways to answer it:

- Move the repository to an organization and turn on the merge queue. Which plans offer the queue,
  and for which repositories, is not checked.
- Protect main with "require branches to be up to date". Each pull request then merges main and
  runs CI again before it lands, one at a time. Which plans offer this for a private repository is
  not checked.
- The agent lands cards in a row: before a card's pull request merges, its own run merges main,
  runs the checks again and retakes its screenshots if client files changed, and only that commit
  merges. This needs no GitHub plan, and holds only for cards the agent runs.

Answered when one way is chosen, its cost on the self-hosted runners is measured for a day with
ten open pull requests, and a card or a settings change carries it out.
