### K: The pane says "No copy yet" for a repository the agent works in

Status: Open. Found by the owner on 2026-11-13. Cause not found.

Under Coding agents, the project WebChat Server showed `webchat` with the tag "No copy yet", while
the agent was online. On the same laptop `webchat-agent status` said "Working in Hzxon/webchat in
its folder", and the agent sent that repository's proposal drafts minutes
later. The tag tells the owner the agent must clone first, which is false, and it made the board's
sync look dead.

What is known: `repoState` in `client/src/components/AgentsView.tsx` shows the tag when `seatFor`
in `client/src/agents.ts` finds no seat for the repository that is online, on an agent that is. A
seat is a row of `agent_repos`, which each check-in of the agent names and which counts as online
for 2 minutes (`server/db.ts`). So either the check-ins did not name the repository, or the page
held an older list. The second fits rule 4 if a new or renewed row does not change `db.stamp`: check
that first.

Done when: the cause is found and has a test, and a page that is open while the agent connects a
folder shows "Ready" for it without a reload.
