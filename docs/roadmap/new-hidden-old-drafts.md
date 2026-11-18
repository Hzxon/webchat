### K: A proposal draft older than the newest 50 messages never reaches the board

Status: Fixed in #283.

Seen: on 2026-11-18 the WebChat Server board showed no waiting proposals while 49 proposal files
on main had no card. The agent had sent each one as a draft between 2026-11-09 and 2026-11-15.
Paging back the owner's chat with the agent in the Coding agents pane showed 60 drafts marked
Draft ready, and the board then listed 33 cards that need the owner.

Cause: the page loaded only the newest page of 50 messages of each agent chat. Card runs, reports
and drafts fill that chat fast, so an older draft fell out of the loaded messages, and
`waitingProposals` reads only those. The agent records a file as sent and never sends it again.

Fix: after the first page, the page loads the rest of each agent chat's history in the background.

Done when the board lists a waiting draft that more than 50 newer messages follow, after a reload.
