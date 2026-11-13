### D: Each harness's sandbox enforces WebChat's rules, and the owner approves from WebChat

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-locked-room.md).

A harness no longer proves that its shell cannot read the secrets before it takes cards: the locked
room keeps them out of reach. Each adapter still hands its harness WebChat's rulebook, as
`claude.ts` and `codex.ts` do: the sandbox required, no reads outside the working folders, network
for packages only, no MCP servers but WebChat's own approval endpoint, neither the owner's settings
nor the repository's. Knobs stay as
D-115 has them. When a harness asks before an action, the owner answers from WebChat, signed
(docs/decisions/harness-approvals.md).
`sandboxProblem` becomes a warning. It replaces docs/decisions/new-harness-isolation-proof.md and
drops docs/decisions/new-sandbox-owned.md. Why: the harness protects the machine; WebChat writes
what it enforces.

A command needs no owner when its adapter's `sandboxed()` says the shell cannot leave the sandbox:
Claude Code asks about some commands it still runs there, such as `PORT=3001 npm test`, and the
owner cannot judge one better than the sandbox. The rulebook's path checks still refuse first.
Claude's adapter says so only while `sandboxProblem` finds nothing, which now also names a managed
`allowUnsandboxedCommands` or `excludedCommands`. Codex and ACP do not say so, and keep asking.

Cost: with a harness whose sandbox reads the owner's files, a teammate's text can get them into the
agent's branch; the README says so. Approvals cover only what a harness asks about.

An ACP agent (docs/decisions/acp-adapter.md) gets the rulebook through its permission answers
alone: it has no switch for the sandbox, the folders or the network, so `agent/rulebook.ts` judges
only what it asks about. What the rulebook cannot decide goes to the owner, as for any harness.
