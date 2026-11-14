### R: Support Hermes as a harness

Status: In review. Unblocked 2026-11-14: the owner chose to run Hermes without isolation or a sandbox, with a warning (docs/decisions/new-hermes-unconfined.md).
Proposed 2026-11-12 from the agent host design.

Order: later, after docs/roadmap/new-harness-linking.md, and after docs/roadmap/new-acp-adapter.md
if Hermes speaks ACP.

Why: the owner wants Hermes among the harnesses an agent can link. WebChat supports only Claude
Code and Codex, and an unsupported harness cannot be linked (docs/decisions/harness-linking.md).

Scope: first find how Hermes can be driven: whether it speaks ACP, how it takes a message without
arguments, how it returns a final answer, what sandbox it has and how WebChat's rulebook reaches
it. Then add it to the ACP list, or write a native adapter beside `claude.ts` and `codex.ts`.

Constraints: Hermes is linked like any harness and may take cards. Its login stays the owner's.

Done when: Hermes appears in setup's pick list and in Settings, a linked Hermes answers a question,
and `webchat-agent link hermes` no longer fails.

Found on 2026-11-14, with Hermes 0.23.1 on this laptop and upstream main read the same day:

- Gap 2 was half WebChat's: `submit_answer` served the schema `{}` before the first turn, which is
  no MCP tool schema, and Hermes dropped the server. It now serves `{ type: 'object' }`.
- Gaps 1 and 2 remain in Hermes for an isolated session: `--safe-mode` and `--ignore-user-config`
  run the turn in a managed worker, which cannot reach a client's MCP servers
  (`launch_credentials_unavailable`). So Hermes runs with the owner's own setup.
- Gap 3 stands: its shell has no sandbox. The README and the warning say so.

A real turn through WebChat's adapter read `sum.js` and answered through `submit_answer` in 22 s.
