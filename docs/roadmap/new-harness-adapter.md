### R: Run cards through a harness adapter, picked per session

Status: Idea. Proposed 2026-11-09 from the harness audit.

Why: the agent's turn, its isolation proof and the setup it loads are Claude Code's command
line, settings files and hook format, in `agent/claude.ts` and `agent/plugin.ts`. The sealed
protocol, `Runs`, `Conversations` and the workflow in the plugin know no harness. A student
whose team uses Codex or OpenCode cannot run an agent at all.

Scope: one `Harness` interface in `agent/harness.ts` with three methods: `turn` runs one turn in
a folder with the brief on stdin and a JSON answer for a schema, `refusal` says why this laptop
cannot run cards with it, and `offers` names the instructions file, the skills folder and the
few knobs it can honor. The Claude adapter is today's code moved behind it, so a Claude Code
owner sees no change. Each harness the laptop found goes to the owner sealed in `SetupState`,
with its state and knobs, and Settings shows one row per harness with an enable toggle instead
of three hard-coded checkboxes. The owner names the harness, signed, in each card run and each
conversation, as the repository is named today (D-093): a second line in the card's play menu
and a picker beside the repository in the composer. No stored default; the page remembers the
last pick in the browser only. A session keeps the harness that started it, so fix rounds and
replies resume with the right one. Turns nobody picked for, "Check again" (D-116) and proposal
drafts (D-117), run on the host harness: Claude Code when the plugin hosts, the first enabled
harness when the daemon does. The check-in's level becomes the union over enabled harnesses.

Constraints: a knob is offered only when the adapter honors it without running code outside
the sandbox and without changing permission or sandbox mode; model, caps, the instructions
file, skills and attribution pass, and permission mode, plugins, hooks and MCP servers never do,
for any harness (D-097, D-115). The server learns nothing new: per-harness state is sealed to
the owner, and `claudeMd` keeps its wire name so old pages and plugins agree. A request from an
old page names no harness and runs on the host harness. A request naming a harness the laptop
has not enabled fails with the reason. No switching mid-session: another harness is a new
conversation. `test/agent.test.ts` gets a fixture per adapter, as `FAKE_CLAUDE` is one today.

Done when: a Claude Code agent behaves as before and the tests pass; Settings lists the
harnesses the laptop has, each with its state and knobs; a card run and a conversation each
show the harness the owner picked; a request from an old page runs on the host harness; a
request naming a harness that is not enabled fails with the reason.
