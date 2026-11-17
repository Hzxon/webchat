### R: Split the files that every card edits

Status: Idea. Proposed 2026-11-17 by the owner, from the parallel work design.

Order: first of the parallel work cards. The overlap gate (docs/roadmap/new-overlap-gate.md) blocks
a run whose files another run holds, so while every card edits the same few files it would let one
card run at a time.

Why: a few files take part in most changes, so any two cards that run at once meet in them. Of the
262 commits in the 60 days to 2026-11-17, `test/agent.test.ts` is in 73, `shared/types.ts` in 61,
`.claude/rules/projects.md` in 60, `client/src/chat.ts` in 57, `client/src/styles.css` in 51,
`agent/plugin.ts` in 49, `server/api.ts` in 46 and `server/db.ts` in 44. D-106 did this for the
roadmap, where 33 of 37 textual conflicts came from one file.

Scope: split each of those eight files by feature, so a card edits the file of its feature and
adds a file for a new one. Tests go to one file per feature beside `test/agent.test.ts`. Types go
to one file per domain, which `shared/types.ts` re-exports. The rules file goes to one file per
area of the projects code, each with its own paths. Routes and queries go to one module per
resource. Each split moves code and changes no behavior.

Constraints: one pull request per file, in a row and never beside each other, since each one
conflicts with every open pull request that edits that file. Start with the files no open pull
request touches. Migrations stay as they are (rule 3).

Done when: each of the eight files is split, `npm run typecheck`, `npm test` and `npm run build`
pass after each split, and none of the files that replace them is in more than a tenth of the next
50 merged pull requests.
