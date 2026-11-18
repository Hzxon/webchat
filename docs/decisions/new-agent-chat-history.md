### D: The page loads the whole history of each chat with the user's own agent

Status: Proposed 2026-11-18 in #283.

A chat with one of the user's own agents loads its first page as before, and once the page's
other first loads are done, the rest of its history, page by page, until the server has no
older rows. A proposal draft waits on the board until its owner adds or dismisses it, however
many runs and reports came after it (R-047), and the agent never sends a file again once sent.
Other chats keep loading one page at a time, on the user's scroll.

Cost: each page load makes one request per 50 messages of an agent chat, and decrypts them all.
An agent chat that grows for months makes the first minute of each load slower. A request that
fails stops the paging until the next load.
