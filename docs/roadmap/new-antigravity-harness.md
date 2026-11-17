### R: Support Antigravity as a harness

Status: In review. Proposed 2026-11-14 by the owner.

Why: the owner wants Antigravity among the harnesses an agent can link. It speaks ACP through
`agy acp`, so it joins the shipped list.

Scope: an entry in `agent/acp-agents.ts`, with the sandbox on and a folder of its own through
`--gemini-dir`; a refused turn in a folder with `.agents/mcp_config.json`; the rulebook taking
Antigravity's `mcp_webchat_` tool prefix; a warning in setup, on the link approval and in Settings.

Found on 2026-11-14 with `agy` 1.5.9: a WebChat turn answered through `submit_answer` in 28 s and
resumed. `--gemini-dir` skipped `~/.gemini`'s MCP config and still signed in. The working folder's
`.agents/mcp_config.json` loaded with or without it, also when written between two turns; a parent
folder's did not.

Done when: Antigravity appears in setup's pick list and in Settings with its warning, a linked
Antigravity answers a question, and a folder with `.agents/mcp_config.json` gets the refusal.
