### R: Approve a harness's actions from WebChat

Status: Done in #204.

Order: after docs/roadmap/new-harness-linking.md. It does not wait for the locked room.

Why: card runs are unattended. Claude Code runs with `--permission-prompts none` and Codex with
`approval_policy="never"`, so an action a harness would ask about is refused, and the owner never
hears of it.

Scope:

- `Harness` gains `ask`, next to `progress`. Claude Code moves to its permission-prompt tool or its
  Agent SDK, and Codex to its app-server, each one process per session.
- The agent sends each question as a sealed message in the owner's direct chat, and the pane shows
  Allow, Allow for this run and Deny. The service worker notifies for a question.
- The owner's signed answer counts once, within 10 minutes, as a `fix` does (D-105). The 2-hour
  silence timer pauses while a question waits; an unanswered one waits as the plan gate does, 7
  days.
- WebChat's rulebook answers what it can alone, such as a read outside the folder: no.

Constraints: new sealed kinds sign their fields (rule 2), and a push for a question holds no plain
text (rule 7). A new `AGENT_LEVEL` bit says the agent asks. No standing rule outlives a run.

Done when: a fake harness that asks gets the owner's Allow from a second device and goes on; Deny
stops that action; a question left 7 days ends the run; tests cover each.
