### D: A harness without a deny-read list runs under a sandbox WebChat owns

Status: Proposed 2026-11-09 in #175, the spike of "A Codex adapter, and a sandbox WebChat owns".

A harness whose sandbox has no deny-read list runs under `@anthropic-ai/sandbox-runtime` with the
plugin's policy: `denyRead` on the gh config, keychains and plugin data, `allowWrite` on the
worktree, the API domain alone, and the token as a `mask` credential. On srt 0.0.81 the denied
folders read as empty, the home is read-only, the namespace has only `lo`, other hosts get a 403,
the API gets the real token and the shell a sentinel. Claude Code keeps its own sandbox: nested
bubblewrap fails inside srt and `failIfUnavailable` refuses to start. Why: D-097 wants this proof
before a run pushes with the owner's login.

Cost: the shell can spend the token toward the API domain, and a credential file such as
`~/.codex/auth.json` must be masked too. srt needs bubblewrap, socat, ripgrep and, on Ubuntu 24.04,
`kernel.apparmor_restrict_unprivileged_userns=0`. Open: that setting made the spike run as root
with `allowAllUnixSockets`, and `codex exec` is not installed here, so the seccomp layer and Codex
are untested.
