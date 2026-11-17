### R: CI fails a pull request that overlaps an earlier open one

Status: Idea. Proposed 2026-11-17 by the owner, from the parallel work design. Needs the decision
in docs/decisions/new-overlap-blocks.md.

Order: after the hot files are split (docs/roadmap/new-split-hot-files.md). It may run beside the
overlap gate, which edits `agent/plugin.ts` and not the workflows.

Why: the overlap gate (docs/roadmap/new-overlap-gate.md) lives in WebChat's plugin, so it holds
only for a card that WebChat's agent runs. A teammate who codes by hand, or a session in their own
harness that claims with `scripts/claim.sh`, passes it by. A check on GitHub holds for every person
and every agent.

Scope: a workflow lists the open pull requests with their files. It fails a pull request that
changes a file an open pull request with a lower number also changes, and names that pull request
and the files. The author passes it by writing `After #12` or `Stacked on #12` in the body, which
says the order was agreed. `scripts/claim.sh` takes the files a session expects to change and
writes the same `Touches:` line the plugin writes, and the check reads that line for a draft that
has no diff yet.

Constraints: the board copy's draft on `agent/board`, the release pull request, and files under
`docs/roadmap/` and `docs/decisions/` never count. The check runs when a pull request changes, so
an earlier pull request that grows into a later one's files is seen only at the later one's next
push; the card says so in the workflow's comment. It runs on the self-hosted runners, as `ci.yml`
does.

Done when: a pull request that shares a file with a lower-numbered open one fails with both named;
`After #12` in its body passes it; two pull requests with no shared file both pass; and a pull
request that only adds a roadmap or decision file passes.
