### D: The agent connects a folder only on the owner's approval in WebChat

Status: Proposed 2026-11-13 in #202 (docs/roadmap/new-connect-approval.md). Changed in #209.

`webchat-agent connect` files a request over the keyholder's socket and returns; the keyholder sends it as
a sealed `ask` of kind `connect`, naming the repository and the folder, and the pane shows both with
Approve and Decline. The agent writes the `connected` mark only on the owner's signed approval, which
repeats the repository and folder, within 10 minutes of its signed time and counted once. The request also
lapses 10 minutes after the agent sent it. An unpaired agent refuses, and one request waits per repository
(D-101). Why: a model running as the owner could type the command and mark any folder.

Cost: the approval waits for the serving agent's next check-in, up to a minute. A model running as the
owner can still type the command, which files a request the owner must approve; it cannot write the mark,
which lives in the keyholder's folder (docs/decisions/locked-room.md). Adding an agent in the page opens its
direct chat, so the agent has a keyed chat to send into.
