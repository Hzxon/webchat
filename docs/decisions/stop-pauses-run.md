### D: A stopped run pauses and keeps its session

Status: Proposed 2026-11-09 in #178.

Stop on a run whose work is unfinished pauses it. The plugin kills the harness's process, pushes
what is committed, and keeps the worktree, the branch, the draft and the session in its watched
record, as `unfinished.paused` with `stopped`. It reports `paused`, and the card says "Stopped.
Tell it what to change, or start over." The owner's next words, a `fix` message with a note,
resume the session with them. A second stop closes the draft and keeps the branch, as a failure
does, and a pause with no words fails after 7 days, as a decision pause does (D-118). While a
turn runs, the adapter turns the harness's output into one sentence on what the model does, and
the plugin sends it as a sealed `progress` report at most every 30 seconds and only when it
changed, to the owner's direct chat, where the pane shows it under "Working…" and the service
worker shows no notification for it. Why: a run was a black box for up to two hours, and Stop
threw its work away. The data path forbids a live connection (D-004), so one look and one
correction per run is what fits.

Cost: a run makes up to 240 sealed messages in the owner's chat with the agent, which Safari
shows as notifications (D-047). A paused run holds its card and worktree for up to 7 days. The
brief that carries the owner's words comes in the card's second pull request.
