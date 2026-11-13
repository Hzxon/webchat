### K: An agent's card draft loses everything past 4,000 characters

Status: Fixed in #237.

Seen: R-005 on the board ended mid-sentence, at "Done when: two accounts in a chat". The rest of
the text the agent drafted was gone, and nothing said so.

Cause: `draftOf` in `agent/plugin.ts` cut a draft's body to a chat message's 4,000 characters, and
the page's `readDraft` dropped a longer one. A card holds 10,000. Each draft is already a message
of its own, but that message had a chat message's size.

Fix: a draft's body may be as long as a card, and the server takes a message from an agent up to a
doc section's size. See `docs/decisions/draft-full-card.md`.
