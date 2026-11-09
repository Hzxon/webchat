### R: Serve the agent from a daemon as well as from the plugin

Status: Idea. Proposed 2026-11-09 from the harness audit. Needs the harness adapter card.

Why: the trusted half of the agent runs only as the MCP server that Claude Code starts
(`agent/mcp.ts`), and one Claude Code window must stay open (D-092, D-094). A laptop without
Claude Code cannot run an agent, whatever harness it has.

Scope: `npm run agent -- serve`, or a published `webchat-agent serve`, builds the same `Plugin`
class with `~/.webchat/laptop` as its data folder, and takes `connect`, `sleep` and `wake` as
subcommands in place of the `/webchat:` skills. `pair` stays as it is. The Claude Code plugin
keeps its host and gains nothing: it stays the first install in the README, and the daemon is
the way for a laptop without Claude Code. The guard hook is Claude Code's hook format and stays
in the Claude adapter.

Constraints: two hosts must not share an account file (D-085); the daemon's `laptop/` folder
is its own. The daemon must be kept running, in a terminal or as a launchd or systemd service,
and the README says so where it says to keep a window open today. D-092's cost line is
rewritten.

Done when: an agent paired from the daemon checks in, answers a question, runs a card with an
enabled harness, and sleeps and wakes from the command line; the README says when to use which
host.
