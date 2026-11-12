### K: An editor in the board's hidden tab loses its lock unseen

Status: Open. Found on 2026-11-12 in the review of #188.

Seen: edit a Roadmap card, switch to the Decisions tab and edit a decision. The Roadmap card's lock
is no longer renewed, so it lapses after 2 minutes (D-081). Its save then fails, and the error
shows in the hidden Roadmap column. This could already happen at phone width, where the columns
were tabs. Since #188 they are tabs at every width.

Cause: each `BoardColumnView` keeps its own `editing`, and both stay mounted. But `client/src/chat.ts`
keeps one module-level `editing`, which `startEditing` sets and each check-in names so the server
renews that one lock. The second editor replaces the first, and closing either one sets it to null.

Fix: allow one editor per board. While one column holds an editor, the other column's Edit and new
card buttons are disabled and say where the open editor is, or switching tabs shows it.
