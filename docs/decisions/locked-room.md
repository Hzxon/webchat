### D: The agent's secrets live under a separate OS user

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-locked-room.md).

Setup creates a hidden account, `_webchat`, with the owner's password once. Its keyholder holds the
agent's keys, its own `gh` login and a copy of each repository, in a folder only it can read, and
does every fetch, push and draft. A runner, as the owner, starts the harnesses. They share one
local socket that carries no secret; git crosses only as bundles the keyholder checks. Its program
is root-owned. Nothing the owner's account does carries authority, only the owner's signed
messages, so connecting a folder or linking a harness from the laptop is a request the owner
approves. Why: the operating system keeps every harness's model from WebChat's secrets.

Cost: a laptop without admin rights cannot run the agent. A copy of each repository on disk, and
runs need the owner logged in. The model still reads the owner's own files, as their
harness allows (docs/decisions/harness-rulebook.md).
