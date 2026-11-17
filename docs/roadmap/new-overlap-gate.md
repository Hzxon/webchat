### R: A run waits when its files overlap a running card's

Status: Idea. Proposed 2026-11-17 by the owner, from the parallel work design. Needs the decision
in docs/decisions/new-overlap-blocks.md.

Order: after the hot files are split (docs/roadmap/new-split-hot-files.md), and beside the wait
edge (docs/roadmap/new-after-edge.md), which touches the board and not the run.

Why: teammates each run several cards at once, and nothing stops two runs from editing the same
files. The check a run makes first (D-116, D-118) asks whether the card still holds, not whether it
can run beside what is running. Its conflicts are warnings that block nothing, a card's `Checked:`
line does not expire when other runs start, and a card that has not started has no file list to
compare. So the clash shows after one pull request merges, and the other run or its owner repairs
it.

Scope:

- The run's check turn also answers `touches`: the files and folders it expects to change. The
  plugin writes them to the draft's body as a `Touches:` line, after `Claims K-12`.
- The plugin lists the open pull requests with their files and their `Touches:` lines. `openPulls`
  in `agent/plugin.ts` asks for `number,title` today and takes more fields. A file two runs share
  is an overlap. This part is a rule, not the model's judgment.
- On an overlap the run does not start its work. The card shows `Waiting for K-12` and names both
  card owners, who get a push, as a run that waits for a decision does (D-118).
- The two card owners choose on the card: wait until K-12 is done, stack on K-12's branch
  (`scripts/restack.sh`, D-106), or fold the two cards into one. The agent never chooses.
- The plugin compares again at each push, with the files the branch really changed. A run that
  grew into a file an earlier draft holds pauses (the pause from #178) and waits the same way.
- The draft with the lower number keeps a shared file. This also settles two runs that each grow
  into the other's files, and two `Touches:` lines published seconds apart: each run compares once
  more after it publishes.

Constraints: the footprint lives in the pull request, which GitHub already sees, and sealed on the
card, so the server learns nothing new (rule 1). The choice counts only when a card owner signed it
(D-081). The board copy's draft on `agent/board`, the release pull request, and files under
`docs/roadmap/` and `docs/decisions/` never count as an overlap. A repository with no GitHub link
has no gate.

Done when: of two cards that touch one file, the second run waits and both owners get a push; each
of the three choices moves it on; a run that grows into a held file pauses before it pushes more;
two cards with no shared file run at once; and a test covers each.
