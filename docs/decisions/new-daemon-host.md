### D: An agent serves from a daemon or from the Claude Code plugin

Status: Proposed 2026-11-09 in #177 (the daemon-host card).

The plugin class that D-092 runs as an MCP server has a second host: `npm run agent -- serve`
builds the same `ClaudePlugin` in `~/.webchat/laptop`, with `connect`, `sleep` and `wake` as
subcommands in place of the `/webchat:` skills. The plugin stays the first install in the README,
and the daemon is for a laptop with no Claude Code window to keep open. The guard hook stays in
the Claude adapter, and the daemon runs it through `agent/mcp.ts`. A laptop has one host per
account: the daemon's folder is its own, so two hosts never share an account file (D-085).
Why: the trusted half of the agent ran only inside a Claude Code session, whatever harness a
laptop had.

Cost: the daemon must be kept running, in a terminal or as a launchd or systemd service. Until
another harness has an adapter, it still needs the `claude` command. Its run needs `tsx`, since
nothing bundles it. Messages the plugin shares with the pane still name `/webchat:wake`.
