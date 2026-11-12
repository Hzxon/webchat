### K: A hand edit of a card can drop or revive a review line

Status: Open. Found on 2026-11-12 in the review of #190.

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

Fix: `beginEditing` reads the card again under the lock, as `rewriteCard` does, and starts from its
`text`. On save, the editor keeps the review lines that stand at that moment in place of the typed
ones, through `withReviews`, unless the owner declines a change by its button.
