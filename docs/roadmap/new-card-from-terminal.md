### R: Make and number a card from the terminal

Status: Idea. Proposed 2026-11-13 by the owner, who works in their harness more than on the board.

Why: a session in the owner's own harness that starts from an idea has no card to claim. Today it
writes a proposal file, the file must reach main, the agent hands it to the owner as a draft, and
the owner adds it on the board, which numbers it (D-117). Only then can `scripts/claim.sh` name the
card. That is one merge and one visit to the board before any work, so the owner skips the card,
and the board never learns of the work. On 2026-11-13 main held 37 proposal files that waited this
way.

Scope: one command of the agent, such as `webchat-agent card docs/roadmap/new-bark-banner.md`,
that sends the file as a card draft to the owner's page, the way an answer's drafts go (D-104).
The owner presses the draft's button, on any device, and the board numbers the card under its lock
(D-116). The command waits, then prints the number, so the session claims it with
`scripts/claim.sh` right away. The draft goes through the agent's check first, as every draft does
(D-116). A decision goes the same way. The proposal file stays the way for a session that has no
agent, such as a teammate's. Nothing new reaches the server: the draft is a sealed message.

Not in scope: showing a card run's diff and turns in the pane. A card run stays the way to work
while away from the laptop.

The terminal never adds a card itself. The owner approves every draft with its button, so the agent
gets no way to write the board and nothing lands unseen (D-104).

Done when: in a linked repository, a session with no card runs the command, the owner adds the
draft, the command prints the new number, `scripts/claim.sh` claims it, and the board shows the
card Running, with no pull request merged in between.
