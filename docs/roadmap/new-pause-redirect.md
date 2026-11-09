### R: Pause a run and redirect it

Status: In progress: the progress line and pause in #178, on the seam (#174). Proposed 2026-11-09
from the harness audit. Needs the harness adapter card.

Order: fourth, after the harness card is done and not beside it: it edits the watched record
and the run, finish and cancel paths that the per-session pick also edits, so running them at
once buys one conflict for nothing. Three pull requests in a row: the progress line and pause,
then redirect and the rule it reveals, then the plan gate. It may run beside the Codex adapter.

Why: a run is a black box for up to two hours, and Stop throws its work away: the draft closes
(D-118), the branch stays, and a new run starts from zero. The owner cannot see a run go wrong,
cannot stop it without losing the worktree and the session, and cannot say what to change.
WebChat is a dispatcher, not a cockpit: the data path forbids open connections (D-004) and a
round trip costs 20 to 40 seconds, so live approvals are out, but one look and one correction
per run fit.

Scope: the adapter turns the harness's output into one sentence, and the plugin sends it as a
sealed `progress` report at most every 30 seconds while it changed, folded into the card for
the owner. Stop on a run whose work is unfinished pauses it: the plugin kills the process,
pushes what is committed, keeps the worktree, branch, draft and session in the watched record
as `unfinished.paused`, and reports `paused`. The owner's next words, the `fix` message with a
note, resume the session with a brief that fences the words and orders a look at `git status`
first. The resumed turn drafts a decision or a card change when the words are a rule for the
team (D-104). The check turn also answers with a short plan; the run reports `planned` and waits
for the owner's go or words through the same `fix` message and the same paused state. The gate
is on by default, decided 2026-11-09, with a knob per harness in Settings to turn it off.

Constraints: owner only, in the direct chat with the agent (D-105). No live connection, no
approval prompts, no text box that steers mid-turn: pause and redirect is the fallback every
harness that resumes a session supports, so no adapter needs more. A paused run with no words
fails after 7 days as a decision pause does (D-118). Later, a redirect may name another
harness, which starts a fresh session in the same worktree; the worktree is the handoff.

Done when: the owner stops a run from a phone, types a correction, and the same session
finishes the card with it; a stop with no words fails the run after 7 days; the plan shows
before the first commit, and the knob turns it off.
