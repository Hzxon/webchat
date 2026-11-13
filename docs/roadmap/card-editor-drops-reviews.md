### K: A hand edit of a card can drop or revive a review line

Status: Fixed in #197.

Seen: an owner opens a card in review and edits it by hand while a reviewer asks for changes. The
owner's save drops the change request, with no Declined line, and the card can close. An owner can
also delete a change request by hand. A reviewer who saves an old draft from their device, which
still holds their approval from before a Run again, makes that approval count again. Neither lets a
member touch someone else's line.

Cause: `BoardView.edit` starts the editor from `card.text` as the board last rendered it, before it
takes the lock, and `beginEditing` in `client/src/docs.ts` prefers the device's draft
(`loadDraft(...) || saved`). `SectionEditor` in `client/src/components/DocView.tsx` then saves the
text as typed. Moves, drafts and run reports go through `rewriteCard`, which reads the card again
under the lock and keeps the review lines that stand.

Fix: the board's editor reads the card again once it holds the lock, and starts from that text.
Each save keeps the review lines that stood then, in place of the typed ones, through
`keepReviews`: only the buttons change a review. A draft on the device gets the same lines.
