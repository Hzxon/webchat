### R: Support Hermes as a harness

Status: Blocked 2026-11-13: Hermes cannot run under WebChat's rules yet, see "Blocked because".
Proposed 2026-11-12 from the agent host design.

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

Blocked because: the Hermes Agent source (NousResearch/hermes-agent at 72c88037, read 2026-11-13)
shows three gaps. The owner chose to block the card until they close.

- `hermes acp` runs inside a shared gateway daemon. It skips the owner's config, hooks, plugins and
  MCP servers only through environment variables, which also need a model and provider for each
  owner, so an entry on the shipped ACP list cannot hold them.
- In that mode the MCP server that WebChat passes likely cannot load, so `submit_answer` cannot end
  a turn; `--safe-mode` drops it outright.
- Its shell runs with no sandbox and asks only for commands it judges dangerous, so `ls` or `curl`
  run without a permission request.

It unblocks when Hermes has an isolated mode that keeps the MCP servers a client passes, and a
sandboxed shell or a request before every command. Then a real run fills its dated check and it
joins the list in `agent/acp-agents.ts`.
