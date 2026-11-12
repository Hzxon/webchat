### D: A review counts from its reviewer's own revision, and an answer from the owner's

Status: Proposed 2026-11-12 in #190 (docs/roadmap/new-board-lanes.md).

Any member asks a person in the project to review a card in review: a line under its status,
`Review: @dan Review required. Asked by @bo 2026-11-12.`, and a direct message. The reviewer
rewrites their line to `Approved`, or `Changes requested` with a one-line note. A verdict counts
only while the reviewer's newest revision holds the line and is newer than the owner's, or the
owner's repeats it; `Accepted` or `Declined` only from the owner's. While a verdict stands, nobody
else moves the card off the status its reviewers saw, but to Open or by a merge. The owner closes
after an approval with no change open, runs it again once every change is answered and one
accepted, which asks those reviewers again and drops other verdicts, or marks it ready, which drops
all. Why: pages hold the gates (D-081). Cost: requests are not checked. A reviewer who left or whose
keys are unchecked counts for nothing, nor does any verdict while the owner's revision does not
open. A hand edit can drop a line (docs/roadmap/card-editor-drops-reviews.md). Run again restarts
only the owner's draft the card names, else sets `Running: <owner>`; a waiting push resumes nothing.
