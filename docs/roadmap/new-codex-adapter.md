### R: A Codex adapter, and a sandbox WebChat owns

Status: Idea. Proposed 2026-11-09 from the harness audit. Needs the harness adapter card.

Order: the spike first and at any time, since it needs no code and its result decides the
second half. The adapter fourth, after the harness card is done, since the picker is how an
owner reaches Codex and the Settings row is where it says why it takes no cards; it may run
beside the pause card, which touches other files. Codex takes cards last, only once the spike
held and the gh token question is answered.

Why: with the seam in place no second harness exists. Codex is the likely first, and it cannot
prove that its shell is kept from the secret folders: its sandbox allows reads everywhere, as
far as its documentation shows. D-097 requires that proof before a run pushes with the owner's
login.

Scope: `agent/codex.ts` runs `codex exec --json --output-schema` with the brief on stdin and
resumes by thread id, with a fixture that prints Codex's JSONL as `FAKE_CLAUDE` prints Claude
Code's. Its `refusal` names the isolation gap, so Codex answers questions in a scratch copy and
takes no cards, and Settings says why. Then a spike, with no code to merge: run `codex exec`
under `@anthropic-ai/sandbox-runtime` (`srt`, the engine behind Claude Code's sandbox) with the
API domain allowed and the token in the environment; check that the shell cannot read
`~/.config/gh` or the keychain; check what Claude Code's own sandbox does when started inside
it. The result goes in a decision either way. If it holds, `refusal` clears when `srt` is
installed and Codex takes cards.

Constraints: answers only is the floor for a harness without an isolation proof, decided
2026-11-09: the accepted risk is that the model reads the GitHub token and puts it in a sealed
answer only the owner reads. `srt` wraps the whole process, so the harness and its shell share
one policy: the shell reaches the model's API domain, which the Claude adapter's shell does
not. Whether `--output-schema` works with `codex exec resume` is to be checked against the
installed version. ACP agents have their own adapter (docs/roadmap/new-acp-adapter.md), which
needs no third harness.

Done when: a Codex agent answers a question about a repository; Settings says why it takes no
cards; the spike's decision is on the board; and, if the spike held, a Codex run opens a draft
pull request.
