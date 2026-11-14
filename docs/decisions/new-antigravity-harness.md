### D: Antigravity runs sandboxed in a folder of its own, and never beside a repository's MCP config

Status: Proposed 2026-11-14 (docs/roadmap/new-antigravity-harness.md).

Antigravity joins `agent/acp-agents.ts` as `agy acp --sandbox --gemini-dir <folder>`. The folder
is the agent's own in the runner's folder, so `agy` reads none of the owner's settings, rules, MCP
servers or plugins, and still signs in from the keyring. `agy` loads the working folder's
`.agents/mcp_config.json` and runs it outside its sandbox, even one written mid-session, so the
adapter refuses a turn while that file exists, checked before every turn. The rulebook takes its
`mcp_webchat_` prefix for WebChat's own tools. Why: the sandbox and the isolation hold, and a
planted config would run a teammate's command as the owner.

Cost: `--gemini-dir` is undocumented. The sandbox covers only the shell, not file, web or MCP
tools. A config the model writes during a turn can load before that turn ends; the warning says so.
