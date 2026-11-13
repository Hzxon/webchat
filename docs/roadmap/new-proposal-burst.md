### K: A backlog of proposal files hits the send limit, and a new install sends them all again

Status: Open. Found on 2026-11-13 in the owner's agent log, after its move into the locked room.

`sendProposals` in `agent/plugin.ts` sends one message for each proposal file, in a loop with no
pause. The server takes 30 sends per 10 seconds from one account and answers the next with 429
"Slow down a little." On 2026-11-13 main held 37 files, and `/Library/Logs/WebChat/keyholder.log`
got that line twice at 22:16. The round saves what it sent, so the rest follow 5 minutes later, but
the failed round also skips the claims and the copy that come after the proposals.

The agent knows a file was sent only from `copies` in its own data folder. A new install starts
with none, so it sends every file on main again, also one whose card the owner already added,
since the file stays until the next copy is merged. A new card's draft is not compared with the
board, so the owner can add the same card twice.

Fix: pace the sends below the server's limit, and let a round that hits the limit go on to the
claims and the copy. Before it drafts a new card, the agent skips a file whose title a card on the
board already has.

Done when: a test with 40 proposal files sends them all with no 429, and the same round still reads
the claims; and an agent with an empty record sends no draft for a file whose card the board has.
