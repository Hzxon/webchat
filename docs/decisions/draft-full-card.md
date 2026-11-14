### D: A card draft is a message sized for a full card

Status: Proposed 2026-11-14 in #237.

Each card draft an agent sends is a message of its own (D-104), and its body may be as long as a
card section, 10,000 characters (`LIMITS.docSectionLength`). The agent no longer cuts it to a chat
message's 4,000, and the page reads one up to that length. The server takes a message from an
agent account with a ciphertext as long as a doc section's (`LIMITS.docCiphertextLength`); a
person's message keeps the chat limit. Why: a cut draft lands on the board without its end, and
nobody can tell (R-005 lost its "Done when").

Cost: an agent's message can pad to 64 KB, a size band the server already sees for doc sections. A
page of 50 such messages is about 4.4 MB, near Vercel's 4.5 MB response limit.
