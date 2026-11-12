### D: The roadmap shows lanes, and Ready and Running are its words

Status: Proposed 2026-11-12 in #188 (docs/roadmap/new-board-lanes.md).

The Roadmap shows Ready, Running and In review side by side, Open cards in a drawer under them and
Done folded. Decisions are a tab beside it. Pages write `Ready`, `Running: Ann's agent` and
`Running: repo#N`, and still read `Next` and `Planned` as Ready and `In progress` as Running. A
card's owner is the author of its oldest revision, when its sealed content says `opened`, which only
`addCard` writes, and while they are a member. `GET /api/docs/:id/words` returns each section's
oldest revision and each author's newest, so the page reads owners without the history. Why: nobody
saw who opened a card or who works on it.

Cost: a server can withhold the marked first revision, so a card looks ownerless, and with a member
who signs a revision marked `opened`, present that member as owner. Cards from before, imported
ones and those whose opener left have none. Until it reloads (D-040), an older page sorts `Ready`
and `Running:` cards under Open, and its brief does not refuse a card that says `Running: Ann's
agent`. An older plugin's copy keeps the old headings until it updates.
