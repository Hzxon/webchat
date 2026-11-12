### R: Ship the agent as one file per OS from GitHub releases

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: first. Every other card of this design installs the agent this way.

Why: the daemon runs only from a copy of this repository, through `npm install` and `tsx`, with
Node 26 (docs/decisions/new-daemon-host.md). A student without Node cannot run it, and the locked
room (docs/roadmap/new-locked-room.md) needs a program the owner's account cannot change.

Scope: the release job builds `agent/index.ts` into one file per OS and processor, with Node
inside: macOS on arm64 and x64, Linux on x64 and arm64. Each release also carries their checksums
and an `install.sh` that picks the file for the laptop, checks it and hands over to
`webchat-agent setup`. `GET /api/config` names the server's release, so the Connect dialog can name
the same one.

Constraints: Release Please owns versions (D-055). Nothing under `agent/` ships with the server
(D-058). The plugin keeps shipping from the `plugin` branch until it retires.

Done when: a release has the four files, their checksums and `install.sh`; on a laptop with no
Node, the script installs the file and `webchat-agent --version` prints the release; a changed byte
fails the check and installs nothing.
