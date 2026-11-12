### D: A request on a card reaches the person asked in their direct chat

Status: Proposed 2026-11-12 in #189 (docs/roadmap/new-board-lanes.md).

A member who asks a card's owner to mark it ready writes `Asked: 2026-11-12. @bo asks its owner to
mark it ready.` under its status line, where the team sees it, then sends the owner a message in
their direct chat. A sealed `card` field names the card's id, doc and section; the header is
unchanged and the text says the same in words, so old messages verify and an older page shows the
text. Its push is an ordinary message's, so only the owner gets one, and a click opens the card.
The page opens the direct chat first, so nothing is written when it cannot key a new chat for the
person (D-018). Marking the card ready drops the lines. Why: a line on the card alone reaches
nobody, and the server must learn nothing new (rules 1, 2 and 7).

Cost: the server can guess that a direct message sent right after a card save is about that card.
These messages sit in a chat between people, so a member asks at most once while their line stays.
Usernames go into card text, which a linked repository holds in plain text (D-117).
