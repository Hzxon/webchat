### R: The agent updates itself to its server's release

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: after docs/roadmap/new-locked-room.md, whose root-owned folder the updater writes.

Why: the agent and its server must speak the same protocol, and asking every student to rerun the
install line for each release is the hassle this design removes.

Scope: a small root-owned updater service reads the server's release from `GET /api/config`,
downloads that release's file, checks it against the release's checksums, swaps it in and restarts
both services. It moves only forward.

Constraints: the keyholder never writes its own program. A failed check keeps the old one. Going
back to an older release takes running the install line again.

Done when: an agent moves to a new release after its server does, with nobody at the laptop; a
release older than the running one is refused; a bad checksum leaves the old program running.
