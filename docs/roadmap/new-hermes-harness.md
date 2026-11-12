### R: Support Hermes as a harness

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: later, after docs/roadmap/new-harness-linking.md, and after docs/roadmap/new-acp-adapter.md
if Hermes speaks ACP.

Why: the owner wants Hermes among the harnesses an agent can link. WebChat supports only Claude
Code and Codex, and an unsupported harness cannot be linked (docs/decisions/harness-linking.md).

Scope: first find how Hermes can be driven: whether it speaks ACP, how it takes a message without
arguments, how it returns a final answer, what sandbox it has and how WebChat's rulebook reaches
it. Then add it to the ACP list, or write a native adapter beside `claude.ts` and `codex.ts`.

Constraints: until the locked room, Hermes answers only, as Codex does. Its login stays the
owner's.

Done when: Hermes appears in setup's pick list and in Settings, a linked Hermes answers a question,
and `webchat-agent link hermes` no longer fails.
