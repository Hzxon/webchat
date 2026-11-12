### D: The daemon connects a folder only on the owner's approval in WebChat

Status: Proposed 2026-11-13 in #202 (docs/roadmap/new-connect-approval.md).

`webchat-agent connect` files a request and returns; the serving agent sends it as a sealed `ask` of
kind `connect`, naming the repository and the folder, and the pane shows both with Approve and
Decline. The agent writes the `connected` mark only on the owner's signed approval, which repeats
the repository and folder, within 10 minutes of its signed time and counted once. The request also
lapses 10 minutes after the agent sent it. An unpaired daemon refuses, one request waits per
repository, and the plugin's `connect` tool keeps its prompt in Claude Code and its direct write
(D-101). Why: a model running as the owner could type the command and mark any folder.

Cost: until the locked room (docs/decisions/locked-room.md), a model running as the owner can still
write the mark file or the request file by hand: this closes only the typed command. The approval
waits for the serving agent's next check-in, up to a minute. Adding an agent in the page opens its
direct chat, so the agent has a keyed chat to send into.
