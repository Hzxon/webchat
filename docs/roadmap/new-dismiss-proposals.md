### K: Older copies of a proposal wait on the board for good

Status: Fixed in #280.

Seen: the board's "cards need you" row and the Open drawer kept 11 proposal drafts on the WebChat
Server board after the owner added the newest copy of each. R-047's change came four times.

Cause: a proposal's thread left `draft` only through the owner's `added` note. The agent sends a
file again each time it changes, and may send one twice (K-71). Each copy is a thread of its own,
so every older copy waited, and the peek offered only Add or Update.

Fix: the peek has a Dismiss button, which sends a signed `dismissed` note in the owner's chat with
their agent, the way `added` works. Only the newest copy of a change to a card, or of a new card by
kind and title, waits; an older copy goes once a newer one came.

Done when: the agents test sees the owner's dismissal and the newest-copy rule, and the e2ee test
opens a sealed dismissal.
