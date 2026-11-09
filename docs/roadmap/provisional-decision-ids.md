### R: A session cites a proposed decision before the board numbers it

Status: Idea. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Why: a session that makes a decision waits for the owner, who adds it on the board, which numbers it
(D-117). Several sessions run at once and all wait on one person. Before the board, a session
reserved a number and went on (D-076).

Scope: code comments, rules lines and the pull request name a proposed decision by its file, such
as `docs/decisions/agent-board-auto-merge.md`. When the board numbers it, the agent's next copy
replaces that path with the number everywhere on `agent/board`. This changes D-117, so the owner
decides it first.

Done when: a session finishes a change that makes a decision without waiting for a number, and
main never shows a file path where a number should be.
