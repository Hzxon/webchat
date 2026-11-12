### D: A harness runs cards only when its adapter proves the shell cannot read the secrets

Status: Proposed 2026-11-09 in #180, from "A Codex adapter, and a sandbox WebChat owns".

A harness takes cards only when its adapter's `refusal(dir)` proves that its shell cannot read the
secret folders: the plugin's data, gh's config and the macOS keychain. Without that proof it
answers questions only, in a conversation's scratch copy, which pushes nothing: `refusal` takes
the turn's purpose, `cards` or `answers`, and an adapter whose only gap is the owner's login
refuses the first and allows the second. Settings shows the gap on its row, and a card request
naming the harness fails with it before the claim check. Codex is the first such harness: its sandbox lets the shell read every folder, as
far as its documentation shows. Its turns run in one `codex app-server` per session with the owner's MCP servers turned off one by
name, hooks off, only the core environment variables, no network and writes only in the copy. The
owner's config.toml and `.rules` still load, since app-server has no flag to skip them
(docs/decisions/harness-approvals.md). Why:
D-097 wants the proof before a run pushes with the owner's login.

Cost: the accepted risk, decided 2026-11-09, is that the model reads the GitHub token and puts it
in a sealed answer that only the owner reads. Codex reads its own `AGENTS.md` and skills on every
turn, whatever the owner chose. Briefs go to OpenAI as well as Anthropic.
