### R: Connect a folder only on the owner's approval in WebChat

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: after docs/roadmap/new-agent-setup.md.

Why: the plugin's `connect` tool asks the owner in Claude Code on every call (D-101), but the
daemon's `connect` subcommand marks the folder at once, and a model running as the owner can type
it.

Scope: `webchat-agent connect` sends a sealed request naming the folder's repository, and the pane
shows it with Approve and Decline. The agent writes the `connected` mark only on the owner's signed
approval, within 10 minutes and once, as it clones (D-108). The plugin's tool keeps its prompt.

Done when: a connect typed in a terminal changes nothing until the owner approves it; an approval
replayed or older than 10 minutes does nothing; a test covers both.
