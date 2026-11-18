### D: The owner dismisses a proposal draft with a sealed note

Status: Proposed 2026-11-18 in #280.

The owner dismisses a waiting proposal draft from its peek. The page sends a message in their
direct chat with the agent whose sealed `dismissed` field names the proposal's client id, as an
`added` note does (D-104). Every device of theirs reads it on its next sync, and only the owner's
note counts. The agent ignores it, so the file stays on main until a person removes it. Only the
newest copy of a change to a card, or of a new card by kind and title, waits, whatever became of
it. Why: older copies waited for good, as nothing but an add ended them.

Cost: a dismissal has no undo, and the agent never sends that version of the file again.
