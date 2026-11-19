---
paths:
  - "agent/**"
  - "test/agent*.ts"
---
# Agent conversations, questions and sleep

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- A conversation's messages carry a sealed `prompt` field naming its prompt's client id, never the server's message id; the plugin heeds only its owner's, in their direct chat with the agent, with a signed send time within 10 minutes and once per client id (D-102, D-089, K-47).
- A conversation's turns run in a scratch repository of its own in the temp folder, never a worktree of the owner's checkout, whose `.git` it would share; nothing from it is pushed. A question with no repository runs in an empty folder there, from the board alone (D-102, R-038).
- The keyholder forgets a folder only on its owner's signed `forget` message in their direct chat, and removes its mark, never its files (D-101).
- While the keyholder's `asleep` file exists, it takes no `watch.lock` and starts nothing new; only the owner's signed `sleep` message or `webchat-agent sleep` writes it, and only `webchat-agent wake` removes it. Both commands carry no authority, since any process of the owner can send them (D-113).
- The page asks only a session whose check-in names `AGENT_LEVEL.answers` or above: older agents check in but ignore prompts, so the pane tells their owner how to update instead (D-103).
- A harness asks the owner only when the request or prompt carries the signed `asks` flag, since an older page never shows a question; without it the adapter starts no approval endpoint or `on-request` policy and refuses, as before. `Turn.ask` rejects only when the run cannot go on, and the adapter then fails the turn with that error (docs/decisions/harness-approvals.md).
- A question is a sealed `permit` in the owner's direct chat; the owner's answer counts once, from the owner, in that chat, within 10 minutes of its signing, for the `seen` hash of what they saw, and a late one says `stale` and leaves the question open. A question waits 7 days by the wall clock in `pollPulls`. The agent allows nothing on its own but a command of a harness whose `sandboxed()` says its shell cannot leave the sandbox, in `LocalBench.turn`, after `judge` passed its paths: `judge` refuses or asks, a grant for this run is exact-match and in memory, and Codex and ACP are never told `acceptForSession`, an amendment or `allow_always` (docs/decisions/harness-approvals.md).
- Claude Code's approval endpoint (`agent/approve.ts`) listens on 127.0.0.1 only, takes a per-process token from a 0600 file in the runner's folder, never from arguments or the environment, refuses a request with an `Origin`, answers one text block with no `structuredContent`, and keeps its held response alive with comments. The tool is hidden from the model with `--disallowedTools` (docs/decisions/harness-approvals.md).
- A question renders as plain text in the pane, never Markdown, since a command can hide in it, and the lock screen shows only "Your agent asks your permission" (docs/decisions/harness-approvals.md).
- A conversation's steps reach its owner only when its signed prompt says `events`, which only a page that shows them sets: sealed `events` prompts in messages of kind `events`, at most one every `EVENTS_MS` and the rest before the answer, each step cut to `LIMITS` with a command's output kept at its end; the runner's steps cross the socket as data, through `readEvents` (R-072).
- A prompt's or reply's signed `card` mark asks the session for exactly one new draft of its kind, from the new card form's fields as they stand, fenced as the owner's words; the agent keeps only that one draft (R-071).
