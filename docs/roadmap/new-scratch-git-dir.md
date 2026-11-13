### K: A conversation's scratch copy keeps its git folder where the model writes

Status: Open. Raised 2026-11-10 by the security audit in #185.

A conversation's turn runs in a scratch repository in the temp folder (D-102). Its `.git` folder
sits inside the folder the harness's shell may write. Between turns the plugin runs `git fetch`
there with hooks on, and `git checkout -f` with hooks off, outside the sandbox. Both read that
repository's config, so a `core.fsmonitor` or a hook the model wrote there would run as the owner.
Claude Code's sandbox appears to protect `.git/config` and `.git/hooks`, which the audit did not
confirm, so this is defense in depth.

Done when the scratch copy's git folder lives outside the shell's writable area, such as in the
plugin's data folder, and the plugin runs git there with `--git-dir` and `--work-tree`, as
`worktreeGit` does for a card's worktree. A test plants a config in the scratch folder and shows
that nothing runs.
