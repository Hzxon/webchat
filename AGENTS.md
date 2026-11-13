# WebChat: start here

Read this file before you change anything in this repository, whether you are a person or an agent.
It holds only what the code cannot tell you. The code tells you the rest: read it.

WebChat is an end-to-end encrypted web chat for college students who run several group projects at
once: chats like WhatsApp, projects with channels like Slack, and a project board of decisions and
roadmap cards. People who connect GitHub follow their pull requests in it, and a coding agent can
run a card for its owner. It runs for free on Vercel's Hobby plan with Supabase Postgres, or on any
Node host with an embedded PGlite database. The [README](README.md) explains it in user terms.

## Where the knowledge lives

- `.claude/rules/` holds the constraints of each area of the code, one file per area, with the
  paths it applies to. Claude Code loads a file when you edit those paths. Any other agent or
  person reads the file for the area they touch. Each line names the decision behind it.
- [docs/decisions.md](docs/decisions.md) is the log of why. When a rule or a code comment names a
  decision, such as D-021, grep that number and read that entry. Do not read the file top to
  bottom. Once the project's board in WebChat is linked to this repository, it is a copy of the
  board's decisions, which the owner's agent writes.
- [docs/roadmap.md](docs/roadmap.md) lists what to do next, known issues and open questions. Pick
  from it when you are asked what to do next. Once the board is linked, it is a copy of the
  board's cards, written the same way. Step 3 of "How to work here" says how to change both files.

Roadmap entries are R-items for features and other work, K-items for known issues and Q-items for
open questions. Each says why it matters, what it covers and when it is done. A question that
belongs to an item goes under that item. An item's status is one of Ready, Idea, Blocked, Running,
In review, Done, Fixed or Dropped. The board still reads Next and Planned as Ready, and In progress
as Running. Numbers never change and are never reused. A dropped item
keeps its number and says why.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies. The engines field pins Node 26. |
| `npm run dev` | Runs the API on port 3000 and the Vite client on port 5173, with PGlite in `data/pglite`. |
| `npm test` | Runs the integration and crypto tests with an in-memory database. |
| `npm run typecheck` | Checks the server, client, service worker, and the tooling with the agent, each with its own tsconfig. |
| `npm run build` | Typechecks, then builds the client, the service worker, the Claude Code plugin and the server. |
| `npm start` | Runs the built app in one Node process. |
| `npm run build:agent` | Builds the agent as one file for this laptop, `dist/agent/webchat-agent`, with Node inside. Needs Node from nodejs.org. |
| `npm run agent -- pair\|watch …` | The agent daemon's command line (R-027, D-085, D-093). |
| `scripts/claim.sh -c "<checked>" K-12 "<title>" [D-077]` | Claims a roadmap item after the check that it still holds and, until the board is linked, reserves the decision number given as the third argument. |

The server log prints the invite code. Set `INVITE_CODE` to choose one. To test with two accounts in
one browser, open the app on two hosts, such as `alice.localhost` and `bob.localhost`. Each host
keeps its own cookies and keys.

## Rules that must hold

These rules protect the product's promises. Rules 3, 6, 7 and 8 have a test that fails when they
are broken, in `test/rules.test.ts`, `test/chat.test.ts` and `test/github.test.ts` (D-091). The
others have no check, so breaking one is a bug even when every test passes. The decision behind
each rule explains why it exists.

1. The server never sees what users write. Text, quotes, reaction emoji and any future content are
   encrypted and signed in the browser. When a change makes new data visible to the server, list it
   in the README section "What it does not protect against". See D-014 and D-020.
2. Bind into the signature every field that the server could change and the client relies on. Add a
   new field so that old messages still verify, the way `kind` was added. See D-016.
3. Migrations only grow at the end. Add a new numbered file under `server/migrations/`. Never edit,
   reorder or renumber an entry that has reached main. See D-010.
4. No connection stays open. Pages learn about changes from `POST /api/sync` and from Web Push. Any
   new state that pages must see has to change the sync fingerprint in `db.stamp`. See D-004 and
   D-021.
5. A chat key goes to exactly the chat's members. The server checks this under a lock: the
   project's for channels, and the group's when someone is added to it or removed from it. When
   someone leaves or is removed, the chat gets a new key they never get, and nothing is sent until
   it exists. See D-015, D-025, D-039, D-043 and D-044.
6. Read query strings with the WHATWG URL API, never with `req.query`. See D-012.
7. A push payload is at most 3,000 bytes and never holds the plain text of encrypted content. See
   D-017.
8. The GitHub token never reaches the browser. See D-033.

## How to work here

Several agents work on this repository at the same time, each in its own session, and each picks
its own roadmap item. Nothing coordinates them except what is on GitHub (D-062).

1. **Check that the item still holds, then claim it before you read code.** An entry can go
   stale: the fix may already be on main, a decision since may settle or forbid it, another entry
   or an open pull request may cover the same change, or it may depend on an item that was
   dropped. So read the entry, grep `docs/decisions.md` and the roadmap for its id and for the
   modules it names, and look at main and the open pull requests (D-107). An item that no longer
   holds is not claimed: open a small pull request that sets its status to Dropped or Done, with
   the reason, the way step 3 says. Otherwise fetch main, cut a branch whose name carries the item,
   such as `claude/k12-bad-push-keys`, and run `scripts/claim.sh -c "<what you checked>" K-12 "<pull
   request title>"`. Until the board is linked, give it the next free decision number as a third
   argument if the change will make a decision. After that it refuses a number: a new decision is a
   file that the owner numbers on the board (step 3). The script refuses an item that is finished or
   that an open pull request already names, prints what names the item, then pushes an empty commit
   and opens a draft pull request that records the check. Its body starts with `Claims K-12`; once
   the board is linked, WebChat's agent reads that to mark the card Running on the board. If it
   refuses, pick another item or number. Work that is not a roadmap item, such as a process change,
   claims the same way by hand: a draft first, with a title and body that say what it covers.
2. **Work on that branch** and push to the same pull request. Do not merge or rebase on main to stay
   ahead of other pull requests. Resolve conflicts once, when GitHub reports them: merge main, fix,
   push. A branch stacked on another one is the exception: when the branch under it lands, run
   `scripts/restack.sh <parent-branch>` instead of merging main, because the squash makes the
   parent's own lines conflict (D-106).
3. **Change the roadmap and the decisions.** The way depends on whether the project's board is
   linked to this repository (R-040, D-117). Until it is, edit them in place, so merges stay easy:
   change your item's status line where it is, and never move the entry or add a table row. A new
   roadmap entry is its own file, such as `docs/roadmap/K-59.md`. Add at most one decision entry,
   at the end of its topic section, with the number you reserved (D-076, D-106). Once it is
   linked, `docs/roadmap.md` and `docs/decisions.md` are copies of the board. A copy has near its
   top the line "This file is a copy of the…". Never edit a copy: the owner's agent writes it, and
   CI fails a pull request that edits one, unless it comes from `agent/board`. Propose the change
   as a file instead:
   - A new entry is a file with a short name, such as `docs/roadmap/new-bark-banner.md`. It holds
     the card: `### K: Title` (or `### R:`, `### Q:` or `### D:`), then the `Status:` line and
     the body. A new decision goes under `docs/decisions/` the same way.
   - A change to an entry is a file named by its id, such as `docs/roadmap/K-12.md` or
     `docs/decisions/D-12.md`. It holds the whole entry as it should read: `### K-12: Title`, the
     `Status:` line and the body. A pull request that finishes an item adds one with the new status
     line, such as `Status: Done in #170.`
   - Never number an entry: the board gives out every number. Once a file is on main, the agent
     hands it to the owner as a card draft, and the owner adds it on the board, which numbers a new
     card. The next `agent/board` pull request deletes the file and writes the card into the copy.
     A session that needs a new decision proposes it and waits for the owner to add it.

   Name scratch files outside the repository after the item, such as `k12-body.md`, because
   sessions share the scratch directory.
4. **Check before you mark ready.** Run `npm run typecheck`, `npm test` and `npm run build`. For a
   change people can see, also try it in a browser with two accounts, at desktop width and at 375
   pixels, in light and dark mode.
5. **Show the owner the evidence and wait for their go.** The pull request body says how the change
   was tested and how to undo it, with screenshots or a recording for a change people can see.
   Then mark the pull request ready. The owner merges. Main is squash-merged, and the squash
   commit's subject is the pull request title followed by "(#N)".
6. **Close what you abandon.** A draft you stop working on blocks its item for everyone else. Close
   it and say why in a comment.

Rules that hold throughout:

- Write commit messages as Conventional Commits. The subject has at most 50 characters, capitalizes
  the first word after the type, uses the imperative and has no final period. The body explains what
  changed and why, wrapped at 72 characters. Never add AI attribution, such as a `Co-Authored-By`
  line for an AI or a "Generated with" line.
- The type in the pull request title sets the next version: `fix` bumps the patch and `feat` the
  minor. Never edit the version or `CHANGELOG.md` by hand. Release Please does both (D-055).
- Write documentation in short, plain sentences with one idea each. Code comments explain why the
  code is the way it is, not what it does.

## Keep these documents alive

These files are the source of truth only while they stay current and short. Update them in the same
pull request as the change they describe.

- When you make a decision, add it to `docs/decisions.md`, or once the board is linked, propose it
  as a file under `docs/decisions/` (step 3): the decision as it stands, why, and what it costs, in
  at most 12 lines. When a decision changes, rewrite its entry to the new state, the same way, and
  name the pull request. Git keeps the history. When it replaces an older decision, mark the old
  one superseded and link the new one.
- When a decision adds a constraint that someone editing an area must hold, add one line to that
  area's file in `.claude/rules/`, with the decision number once the board has given it.
- When an agent does something wrong that the code could not have told it, add one line to the
  rules file for that area, or to this file if it holds everywhere. Delete lines that stop earning
  their place.
- When you start, finish or set aside work, update its entry in `docs/roadmap.md` in place, or once
  the board is linked, in a file named by its id under `docs/roadmap/` (step 3). When you find a
  gap or a bug you are not fixing, add an entry for it the same way.
- When a document and the code disagree, the code is what runs. Fix the document, or record the bug
  in the roadmap.
