### D: A harness's questions go to the owner in WebChat, and each harness is one process per session

Status: Proposed 2026-11-13 in #204 (docs/roadmap/new-harness-approvals.md).

Where the owner's page can show a question (a signed `asks` flag, an `AGENT_LEVEL.asks` bit), a
harness that asks before an action asks the owner: Allow, Allow for this run or Deny, once, within 10
minutes of the signing. A question left 7 days ends the run; the 2-hour silence timer stands still
meanwhile. The rulebook only refuses or asks, but for a command a sandbox holds (docs/decisions/harness-rulebook.md). "For this run" covers exactly the same action, in
memory: no rule outlives a run. At most 3 questions are open and 25 asked for a run. Without the
flag the harness refuses what it would ask, as before. Claude Code is one stream-json process per
session, asking through its prompt tool; Codex is one `app-server` per session, answering accept or
decline; both end 10 minutes after a turn. Cost: idle processes for watched drafts, and Codex's
`.rules` files keep applying, which app-server cannot turn off.
