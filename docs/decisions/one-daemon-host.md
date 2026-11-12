### D: One daemon per laptop is the agent's only host

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-agent-setup.md).

The agent runs as `webchat-agent`, one per laptop, installed with one line and kept running by the
system's service manager. It runs the harnesses the owner links. The Claude Code plugin keeps
hosting, and guarding the owner's own sessions, until the locked room is in; then it retires and
setup moves its account. Until then the README offers the plugin to Claude Code users and the
daemon to everyone else. It replaces docs/decisions/new-daemon-host.md, where the plugin stays the
first install. Why: one way to start the agent, online with no window open, and no harness needed
only to host it.

Cost: a service runs around the clock. It checks in every 15 seconds, and every 60 seconds after
an idle hour, about 1,440 requests a day for an idle agent, so a card on an idle agent waits up to
a minute to start. The plugin's host code stays until the locked room, so two hosts live side by
side until then.
