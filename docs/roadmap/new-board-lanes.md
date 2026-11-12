### R: The roadmap as lanes, with a card owner who holds its gates

Status: Idea. Proposed 2026-11-12 from the review of the board's interface.

Why: the board shows work as two lists, and a card's row says only its id, title and status.
Nobody sees who opened a card, who works on it or whose move it is. A card moves only when someone
edits its Markdown. A card an agent runs follows its run (D-100); a card a person works on has
nothing like it. So a team cannot manage its work from the board.

Terms: a card's owner is the member who opened it, as a pull request's author is. It is neither
the project's owner (D-045) nor an agent's owner (D-089).

Scope:

- Lanes: the Roadmap shows Ready, Running and In review side by side. Open cards sit in a drawer
  under them, and Done stays folded. Decisions become a tab beside the Roadmap. In a narrow window
  the lanes stack, and a phone opens on the Roadmap.
- Open means found, and its owner must decide before it is ready. Ready means it waits for someone
  to pick it. Running means a member or an agent picked it and works on it. In review means the
  work is done and needs a person's review.
- Ready and Running are status words in the card's text, not only the lanes' names. The run
  reports (D-100), the repository copy's sections and the status a claim sets (D-117), and the
  status list in AGENTS.md change with them. The board still reads `Next`, `Planned` and
  `In progress` as Ready and Running, so a card from before, or a report from an older page, keeps
  its lane.
- A card's face shows its title, its owner's face on the left, and on the right whose move it is: a
  pick button in Ready, who runs it in Running, the reviewers in In review. The rest, the
  Unchecked tag included, is in the opened card.
- Ready: any member can ask for an Open card to be marked ready. Only its owner marks it.
- Pick: any member, or their agent, picks a Ready card, which moves it to Running.
- A running card whose run waits for a decision (D-118) changes color and names its owner, who
  gets a push.
- Review: any member can request a review of a card In review, from any member. A reviewer
  approves or asks for changes, in the words of the pull request tags (`PullTags.tsx`).
- A requested change keeps the card In review until its owner accepts it, and then until its owner
  runs it, which moves it to Running. The owner may decline it instead. While a requested change is
  neither declined nor accepted and done, the card cannot be closed.
- Close: after an approval, only the owner closes the card, which moves it to Done. A merged pull
  request still sets its run's card to Done, as today (D-118).
- A card a member's agent drafted belongs to the member whose page added it (D-104). A card that a
  board's link imports has no owner. Neither has a card whose owner left the project. Any member
  can take a card with no owner, and becomes its owner. There is no other hand-over.
- A gate waits for an owner who is silent but still a member. Nobody else passes it.
- The board shows no due date, no deadline and no mark for a card that went quiet.

Constraints: the server cannot read a card, so pages hold the gates. A move counts only when the
member allowed to make it signed the revision that made it (D-081), as a board's link counts only
when the project's owner wrote it (D-117). The page gets only the newest revision's author today
(`DocSection.authorId`), so it also needs each card's first author. A move writes the card's status
line under its lock, as a run's reports do (D-100). A request, to mark ready or to review, is on the
card, where the team sees it. It reaches the person asked as an encrypted message in their direct
chat with the member who asks, with a sealed field that names the card, so only they get a push and
the server learns nothing new (rules 1, 2 and 7).

This changes D-082, where status is wording and not a field, D-100 and D-117. The owner decides it
on the board first. R-001, a Jira-style task board, was dropped for R-021; this keeps R-021's cards.

Done when: a card moves through Open, Ready, Running, In review and Done with no edit of its
Markdown; a member who is not its owner cannot mark it ready, accept or decline a change, run it
again after one or close it, and a test covers each; the person asked, and nobody else, gets a push
for a request; a card with no owner can be taken; a card that says `In progress` shows in Running;
the board works at 375 pixels, in light and dark mode.
