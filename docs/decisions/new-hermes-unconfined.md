### D: Hermes runs unconfined, and the owner is told before linking it

Status: Proposed 2026-11-14 (docs/roadmap/new-hermes-harness.md). It changes docs/decisions/acp-adapter.md.

Hermes joins `agent/acp-agents.ts` with no isolation and no sandbox. Hermes 0.23.1 runs a session
started with `--safe-mode` or `--ignore-user-config` in a managed worker, which cannot reach the
MCP servers a client passes, so `submit_answer` never loads (upstream main on 2026-11-14 is the
same). An entry may leave out `isolation` only when `HARNESS_WARNING` in `shared/types.ts` names
it; the list-shape test holds that. The warning shows in setup's pick list, on the pane's link
approval and in its Settings row, linked or not. Why: the owner chose Hermes as it is over no
Hermes, and the locked room still keeps the agent's keys and `gh` login from it.

Cost: Hermes loads the owner's config, memory, plugins, hooks and MCP servers, and its shell asks
only about commands it judges dangerous, so a teammate's text can reach the owner's files and tools.
