### R: Keep the agent's secrets in a locked room

Status: Idea. Proposed 2026-11-12 from the agent host design.

Order: after setup, linking and the connect approval. A spike first, with nothing to merge: a
hidden user run by a launchd LaunchDaemon, `gh` keeping its login in a file for a user with no
keychain, and a branch crossing between two users as a bundle.

Why: the agent's keys and the owner's `gh` login sit in the owner's account, so a harness that can
read the owner's files can read them. Only Claude Code proves it cannot
(docs/decisions/new-harness-isolation-proof.md), so Codex takes no cards.

Scope:

- Setup creates `_webchat` with the owner's password, once, and installs the program root-owned.
- A keyholder service runs as `_webchat`: the account, the checks, `Runs`, `Conversations`, every
  `gh` call, clones, pushes, drafts and the board copy. A runner service runs as the owner: the
  worktrees, the harness turns, the owner's setup, commits and bundles.
- One local socket joins them, in a folder only `_webchat` writes. It carries no secret.
- Git crosses only as bundles. The keyholder never runs git in a folder the owner owns, and pushes
  a bundle only when it touches nothing but the run's `agent/*` branch.
- The agent gets its own `gh` login through GitHub's device sign-in, in a `gh` copy setup installs.
- Setup moves the account from the plugin's or the daemon's folder without pairing again. The
  plugin then retires as a host.
- WebChat drops its isolation check: `refusal(dir)` loses that meaning, `CODEX_GAP` and the guard
  hook go, and `sandboxProblem` becomes a warning in Settings. Claude Code keeps WebChat's settings.
- Without admin rights, setup stops before it changes anything: such a laptop is not supported.

Constraints: nothing the owner's account does carries authority; only the owner's signed messages
do. The keyholder's program and service files are root-owned. D-092, D-094, D-097 and D-113 are
rewritten in the pull request that retires the plugin. A plugin user without admin rights then
has no agent; the README says so before the plugin retires.

Done when: a harness turn that reads the agent's account file gets Permission denied; Codex runs a
card to a draft; a plugin user's account moves without a new pairing; setup without admin rights
changes nothing; `uninstall` deletes `_webchat`.
