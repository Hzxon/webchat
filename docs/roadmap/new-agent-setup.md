### R: Set up the agent with one command

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: second, after docs/roadmap/new-agent-build.md. It may run beside
docs/roadmap/new-harness-linking.md, which owns the harness pick that setup shows.

Why: connecting an agent today takes a copy of this repository, `npm install`,
`npm run agent -- serve '<code>'` and a terminal kept open, or a Claude Code window kept open
(README). Students give up before the agent is online.

Scope:

- The Connect dialog shows one line for the laptop's OS, with the pairing code and the server's
  release in it. On Windows it points to WSL2.
- `webchat-agent setup <code>` runs read-only checks first: OS and processor, the service manager,
  git, the network, disk space and the harnesses. It shows one summary and asks once. It installs
  git with the system's package manager, offers a missing harness's own installer, and never
  changes a security setting: for WSL2 without systemd, or Ubuntu's user namespaces, it prints the
  fix.
- It pairs, saves the login shell's PATH and installs a login service, a launchd LaunchAgent or a
  `systemd --user` unit, that runs `serve`.
- `webchat-agent doctor` reruns the checks, `status` says what serves, and `uninstall` removes the
  service and the account folder.
- The README offers this line to laptops without Claude Code, and keeps the plugin for Claude Code
  users until docs/roadmap/new-locked-room.md.

Constraints: no locked room yet: the keys stay in `~/.webchat/laptop` and the agent pushes with
the owner's `gh`, as the daemon does today. The service checks in every 15 seconds, and every 60
seconds once an hour passes with no request, run or turn, so a card on an idle agent waits up to a
minute to start. The page counts an agent online for 2 minutes after a check-in instead of
`ONLINE_WINDOW_MS`, 60 seconds, so an idle agent never flickers offline.

Done when: on fresh macOS and Ubuntu laptops the line pairs an agent that answers a question once
the owner approves it; `doctor` names a missing harness sign-in; `uninstall` leaves no service
behind.
