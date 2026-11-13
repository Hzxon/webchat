### D: The agent's secrets live under a separate OS user

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-locked-room.md), built in #206, #207, #208 and #209.

Setup creates a hidden account, `_webchat`, with the owner's password once. Its keyholder holds the
agent's keys, its own `gh` login and a full clone of each repository, in a folder only it can read, and
does every fetch, push and draft; its program, `git` and `gh` are root-owned, which it checks at start. A
runner, as the owner, starts the harnesses. They share one local socket that carries no secret and no
authority. Git crosses only as bundles, both ways: the keyholder sends the base as a bundle, and accepts
a run's bundle only when it holds the run's one `agent/*` branch. It writes the board's copy with git
plumbing, never a checkout. For a harness that cannot commit, such as Codex, the runner commits what it
left. Nothing the owner's account does carries authority, only the owner's signed messages, so connecting
a folder or linking a harness from the laptop is a request the owner approves. With no runner connected
the agent shows offline and requests fail at once. Why: the operating system keeps every harness's model
from WebChat's secrets, so no harness has to prove it.

Cost: a laptop without admin rights cannot run the agent, and the Claude Code plugin no longer hosts it.
A copy of each repository on disk, and runs need the owner logged in. An administrator's password reads
the agent's files. The model still reads the owner's own files, as their harness allows
(docs/decisions/harness-rulebook.md).
