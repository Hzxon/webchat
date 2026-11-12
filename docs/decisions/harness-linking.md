### D: The owner links each harness, from the list WebChat supports

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-harness-linking.md).

Supported harnesses are Claude Code and Codex, through built-in adapters, and the ACP agents on a
list shipped with the daemon. Setup lists those it found and the owner picks which to link; the
pairing approval shows the picks. Later, Settings links or unlinks one as a signed setup choice,
and `webchat-agent link` is a request the owner approves. Nothing links on its own, and an
unsupported harness cannot be linked. A request with no pick runs on the first linked harness.
Claude Code and Codex keep native adapters and move to their long-running protocols for approvals.
It changes docs/decisions/new-harness-pick.md: enabled becomes linked. Why: the owner chooses
every harness, and WebChat runs only harnesses it can hand its rulebook to.

Cost: support for a new harness waits for a release. A harness installed later stays unlinked
until the owner links it.
