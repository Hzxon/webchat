### D: A root-owned updater moves the agent to its server's release

Status: Proposed 2026-11-13 in #210 (docs/roadmap/new-agent-self-update.md).

Setup installs a job that runs `webchat-agent update` as root every 15 minutes, from the root-owned
program: a LaunchDaemon, or a systemd timer. It reads the server from a root-owned `update.json`, asks
`GET /api/config` for the release, and only for a newer `x.y.z` downloads that release's file and its
`.sha256` from the address built into the agent, with no login. A file that fails the checksum or its
`--version` is dropped. The swap is a rename and waits until the keyholder reports nothing running, or 24
hours; root restarts the keyholder, the runner restarts itself, and a keyholder that does not answer as the
new release in 2 minutes is rolled back and that release skipped. Why: no one reruns the line.

Cost: a changed release runs as root on every laptop within 15 minutes, and its checksum comes from the
same place. While the repository is private nobody updates: the download is refused and `doctor` warns.
