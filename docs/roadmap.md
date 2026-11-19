# Roadmap

This file is a copy of the Roadmap column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes a new entry as a file under `docs/roadmap/`, named by a short name such as `new-bark-banner.md`, or a change to one as `docs/roadmap/K-12.md`.

## Running

### R-005: Photos and files

Status: In review in #236 and #238. The Vercel path waits for a private Blob store.

Why: students share drafts, slides and screenshots. WebChat sends text only.

Scope:

- The message box takes a photo or a file of an allowed type: JPEG, PNG, WebP, GIF, PDF, Word, PowerPoint, Excel, plain text and zip. No programs, scripts, HTML or SVG.
- The page resizes a photo to at most 1600 pixels and encodes it again before upload, which also removes its GPS position and device details. Any other file is at most 10 MB (`LIMITS`, D-011).
- The browser encrypts the file with a random AES-256-GCM key of its own and uploads only the ciphertext.
- The message is an ordinary message of kind "message" whose sealed content carries a `file` field: the file's id, key, name, type and size, and for a photo its width, height and a tiny blurred preview. Its text says the same in words, so an older page, a push and the chat list show something, as with `pull` (D-042). The signature covers it (D-016), and the server never sees the name, the key or the preview.
- The page asks the server for an upload address, uploads, then sends the message. To show a file it asks for a download address, which the server gives only to a member of the file's chat.
- The receiving page checks every file after it decrypts it: the type must be on the list, and the file's first bytes must match the type its name claims. It refuses any other file with a note, whatever the sender's page did.
- A photo shows inline through `<img>`. Every other file shows as its name and size with a download button, and is never opened inside the page.
- The server drops a file 7 days after it was sent. The message stays: it shows the name, the size and the preview with "No longer on the server". The page tells from the message's time and asks for nothing. The message box says "Kept for 7 days" when a file is attached.
- A photo whose upload or send failed stays on the device with the unsent message, for a retry (D-051).
- Deleting a chat, a channel, a project or an account also deletes the stored ciphertext of its files (D-039, D-088, D-096). An upload that no message followed is deleted after an hour.

Constraints:

- Vercel Functions accept request bodies of at most 4.5 MB, so on Vercel the ciphertext goes from the browser straight to a private Vercel Blob store through a presigned URL, which enforces the size. A self-hosted server takes the upload on a route of its own and keeps the ciphertext on disk. The page uploads to whatever address the server answers (D-005).
- Free hosting (D-003): Hobby includes 1 GB of storage, 2,000 uploads and 10 GB of downloads a month, shared with the rest of the project, and a store that goes over is blocked for 30 days. The server counts uploads and stored bytes and refuses a new upload before either limit.
- No scheduler: the server refuses a download address for a file older than 7 days, and deletes expired ciphertext when it next gives an upload address.
- No scan on the server: it holds only ciphertext (D-014). The README says that nobody scans files and that the checks above catch a wrong type, not malware inside an allowed one.
- The Content Security Policy must allow the storage hosts in `connect-src` and `blob:` in `img-src`, in `vercel.json` and `server/app.ts` together (D-009).
- The server learns who uploaded a file, to which chat, when and how large, and the storage service holds the ciphertext. D-020 and the README list that.
- A new `files` table ties each file to its chat, in a new migration (D-010). The upload does not go through `request`, whose timer would cut a slow upload after a minute (D-077).
- Tests run against a fake storage service and check that no plain text and no key reaches it (D-036).

Needs D-123.

Not yet confirmed: that a browser can fetch a presigned Blob URL from the page's origin (CORS), and which host a presigned upload goes to. Try both in a short spike before the rest. #236 found from the SDK's source (`@vercel/blob` 2.9.0) that an upload goes to `https://vercel.com/api/blob/` and a download to `https://<store>.private.blob.vercel-storage.com`. CORS is still unconfirmed: there is no store to try it against.

Done when, with two accounts that share a chat, one sending and the other receiving:

1. Alice sends a photo and a PDF, and Bob opens both. This works on Vercel and on a self-hosted server.
2. The uploaded photo is at most 1600 pixels and carries no GPS data.
3. The storage and the database hold no plain text, file name or key, and a test proves it.
4. A file over the size limit, or of a type off the list, is refused before it uploads.
5. A program renamed to `.pdf` that got past the sender's check is refused on Bob's page, and a test proves it.
6. Someone outside the chat gets no download address.
7. A file older than 7 days gets no download address either. Its ciphertext is gone after the next upload, and its message still shows the name and the preview.
8. Deleting the chat deletes its stored files.
9. The README and D-020 list what the server and the storage service see, and say that nobody scans files.

### Q-6: How does a pull request get tested on the main it lands on?

Status: Running. Raised 2026-11-17 from the parallel work design. The owner chose the second way that day, and #262 set it in main's ruleset. The day's measurement is still open.

CI checks a pull request against the main it started from, and nothing checks it again after main
moves (D-076). The overlap gate (docs/roadmap/new-overlap-gate.md) and the wait edge
(docs/roadmap/new-after-edge.md) keep runs apart, but nothing proves they did: two pull requests
that clash in a way neither sees still pass and both merge. D-076 records that GitHub's merge
queue needs a repository an organization owns.

The ways to answer it:

- Move the repository to an organization and turn on the merge queue. Which plans offer the queue,
  and for which repositories, is not checked.
- Protect main with "require branches to be up to date". Each pull request then merges main and
  runs CI again before it lands, one at a time. Which plans offer this for a private repository is
  not checked.
- The agent lands cards in a row: before a card's pull request merges, its own run merges main,
  runs the checks again and retakes its screenshots if client files changed, and only that commit
  merges. This needs no GitHub plan, and holds only for cards the agent runs.

Answered when one way is chosen, its cost on the self-hosted runners is measured for a day with
ten open pull requests, and a card or a settings change carries it out.

## Ready

### R-014: Cards for pasted pull request links

Status: Planned.

Why: a pasted `github.com/.../pull/N` link renders as bare text (`linkify` in
`client/src/components/format.tsx`). Students paste links all day and have to open each one to see
whether it is reviewed or merged.

Scope: after decrypting a message, the page spots pull request links and asks a new endpoint,
`GET /api/github/pull`, for the title and status, with the viewer's own token. The server caches the
answer for a minute. The card shows the same tags as the pane.

Constraint: the server learns which pull request a viewer looked up. List that in the README and in
D-020. Without a connected account, the link stays a plain link.

### R-015: Catch comment-only reviews

Status: Planned.

Why: a review submitted as "Comment" moves neither `reviewDecision` nor the conversation comment
count that `PULL_FIELDS` in `server/github.ts` reads, so the author hears nothing. Student teams
leave this kind of review often. Not yet confirmed against GitHub.

Scope: add `reviews(last: 1) { totalCount nodes { state author { login } } }` to the query, and
report a `commented` event when the count grows and the newest review is by someone else. Also
report a comment by someone else when two comments arrive between polls and the newest is the
user's own (`comparePulls` only looks at the last commenter).

Done when: a comment-only review on the fake GitHub becomes an event, and a test proves it.

## Ideas

### R-004: Private channels

Status: Idea.

Every project member is in every channel (D-024). A private channel needs its own member list, keys
wrapped only for that list, and a new rule for adding people to a project without adding them to
every channel (D-025).

### R-006: Mentions

Status: Idea.

An @name in a channel would notify the person mentioned. The server cannot read the text, so it
cannot find mentions itself. Either the page sends the mentioned people's ids as signed metadata
the server can see, or each recipient's page or service worker looks for mentions after decrypting.
The first option shows the server who was mentioned, which D-020 would have to list.

### R-007: Edit and delete messages

Status: Idea.

Model them like reactions: new kinds of events that point at a message, with the kind signed
(D-016, D-030). Deleting can only hide a message in members' pages. Anyone who already loaded it
keeps their copy.

### R-008: Search

Status: Idea.

The server cannot search encrypted text. Search has to run in the page over decrypted messages, so
the history must be loaded or kept on the device, for example in IndexedDB.

### R-009: Threads

Status: Idea.

Replies quote a message (D-029) but do not open a side conversation like a Slack thread. Find out
whether quotes are enough for students before building threads.

### R-010: Deadline reminders

Status: Idea. Depends on R-001, which was dropped for R-021.

Reminders need a scheduler, because Vercel Hobby cron jobs run once a day. Reuse the `CRON_SECRET`
approach of the GitHub connector (D-034). A reminder that shows a task's title must be decrypted on
the device, like a message (D-017).

### R-011: Typing indicators and instant presence

Status: Blocked on Q-1.

Presence comes from check-ins: a person counts as online for a minute after a check-in from a tab
they were looking at. A tab open in the background does not keep them online. Typing indicators need
a faster channel than check-ins (D-004).

### R-012: Voice and video calls

Status: Idea, out of scope for now.

Calls need WebRTC and TURN servers, which cost money (D-003).

### R-017: Notes in a chat when people join or are removed

Status: Idea. Found while building R-003 on 2026-11-01.

Any member can add someone to a project or group, and the newcomer reads the whole history (D-026,
D-043). The other members see it only in the member count and the member list. WhatsApp shows
"Alice added Carol" in the chat, and Slack shows "Carol joined #general". A note in the message
list would tell everyone who can read along. The server already knows when each member joined, so
the notes would show it nothing new. They should not count as unread.

### R-056: A session cites a proposed decision before the board numbers it

Status: Idea. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Why: a session that makes a decision waits for the owner, who adds it on the board, which numbers it
(D-117). Several sessions run at once and all wait on one person. Before the board, a session
reserved a number and went on (D-076).

Scope: code comments, rules lines and the pull request name a proposed decision by its file, such
as `docs/decisions/agent-board-auto-merge.md`. When the board numbers it, the agent's next copy
replaces that path with the number everywhere on `agent/board`. This changes D-117, so the owner
decides it first.

Done when: a session finishes a change that makes a decision without waiting for a number, and
main never shows a file path where a number should be.

### R-064: A Codex adapter, and a sandbox WebChat owns

Status: Idea. Proposed 2026-11-09 from the harness audit. Needs the harness adapter card.

Order: the spike first and at any time, since it needs no code and its result decides the
second half. The adapter fourth, after the harness card is done, since the picker is how an
owner reaches Codex and the Settings row is where it says why it takes no cards; it may run
beside the pause card, which touches other files. Codex takes cards last, only once the spike
held and the gh token question is answered.

Why: with the seam in place no second harness exists. Codex is the likely first, and it cannot
prove that its shell is kept from the secret folders: its sandbox allows reads everywhere, as
far as its documentation shows. D-097 requires that proof before a run pushes with the owner's
login.

Scope: `agent/codex.ts` runs `codex exec --json --output-schema` with the brief on stdin and
resumes by thread id, with a fixture that prints Codex's JSONL as `FAKE_CLAUDE` prints Claude
Code's. Its `refusal` names the isolation gap, so Codex answers questions in a scratch copy and
takes no cards, and Settings says why. Then a spike, with no code to merge: run `codex exec`
under `@anthropic-ai/sandbox-runtime` (`srt`, the engine behind Claude Code's sandbox) with the
API domain allowed and the token in the environment; check that the shell cannot read
`~/.config/gh` or the keychain; check what Claude Code's own sandbox does when started inside
it. The result goes in a decision either way. If it holds, `refusal` clears when `srt` is
installed and Codex takes cards.

Constraints: answers only is the floor for a harness without an isolation proof, decided
2026-11-09: the accepted risk is that the model reads the GitHub token and puts it in a sealed
answer only the owner reads. `srt` wraps the whole process, so the harness and its shell share
one policy: the shell reaches the model's API domain, which the Claude adapter's shell does
not. Whether `--output-schema` works with `codex exec resume` is to be checked against the
installed version. ACP agents have their own adapter (docs/roadmap/new-acp-adapter.md), which
needs no third harness.

Done when: a Codex agent answers a question about a repository; Settings says why it takes no
cards; the spike's decision is on the board; and, if the spike held, a Codex run opens a draft
pull request.

### R-070: The board's copy merges without the owner

Status: Idea. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Why: main lags the board until the owner merges the `agent/board` pull request (D-117). Each sync
is one more chore for the owner. Sessions read the repository's copy, so a late merge sends them to
stale cards. The first copy (#170) changed 2,300 lines of `docs/decisions.md`, too much to review
by eye, so a review adds little.

Scope: the agent asks GitHub to merge `agent/board` once its checks pass, with
`gh pr merge --auto --squash`. CI already fails a pull request whose copy anyone else edits, and the
branch changes only the two copies and the proposal files the owner added. The owner can switch it
off on the board. This changes D-117, so the owner decides it first.

Done when: a board change reaches main with no click from the owner, and a pull request that
touches anything else on `agent/board` waits for them.

## Known issues

### K-77: picomatch has a ReDoS advisory with no patched release

Status: Blocked. Found 2026-11-18 by `npm audit` while fixing the zod advisory in #281. Waits for a picomatch release after 4.0.7.

Why: `npm audit` reports GHSA-fc5q-39xc-vjpf (high): picomatch can take very long on a glob with
repeated single-branch extglobs. Every version up to 4.0.7, the newest, is affected, so no update
or override fixes it. A red audit hides new advisories that do matter.

Scope: picomatch comes in only through devDependencies: `vite` (directly and through
`tinyglobby` and `fdir`) and `@astryxdesign/cli` (through `jscodeshift`). `npm ls picomatch
--omit=dev` is empty, so neither the server nor the client bundle holds it. The patterns come from
our own build config, not from users, so nobody outside can reach it. Dependabot opened no alert.

Fix: when picomatch publishes a patched version, update the lockfile so every path resolves to it.
Do not run `npm audit fix --force`: it downgrades vite to 6.2.7, a breaking change.

Done when: `npm audit` reports no picomatch advisory.

### K-80: A reverted run's card stays Done

Status: Open. Found on 2026-11-09 in the review of the board as the source of truth (R-040).

Seen: #159 fixed K-1 and #169 reverted it. Nothing tells the board. Once a run's draft merges, the
card says `Done in repo#N` or `Fixed in repo#N`, and the plugin stops watching (D-118). A revert
then leaves a finished card for work that main no longer has. The team only learns of it by hand.

Fix: the owner's agent already lists open pull requests for a linked board (`sendClaims` in
`agent/plugin.ts`). It also looks at merged ones whose body says `Reverts` or `This reverts commit`
of a pull request a finished card names. The owner's page then sets that card back to `Open` with a
line that names the revert, under its lock, as it does for other moves.

Done when: a merged revert of a card's pull request reopens the card, and a test proves it.

### K-81: A conversation's scratch copy keeps its git folder where the model writes

Status: Open. Raised 2026-11-10 by the security audit in #185.

A conversation's turn runs in a scratch repository in the temp folder (D-102). Its `.git` folder
sits inside the folder the harness's shell may write. Between turns the plugin runs `git fetch`
there with hooks on, and `git checkout -f` with hooks off, outside the sandbox. Both read that
repository's config, so a `core.fsmonitor` or a hook the model wrote there would run as the owner.
Claude Code's sandbox appears to protect `.git/config` and `.git/hooks`, which the audit did not
confirm, so this is defense in depth.

Done when the scratch copy's git folder lives outside the shell's writable area, such as in the
plugin's data folder, and the plugin runs git there with `--git-dir` and `--work-tree`, as
`worktreeGit` does for a card's worktree. A test plants a config in the scratch folder and shows
that nothing runs.

## Open questions

### Q-1: Should updates move to WebSockets?

Status: Open.

Vercel Functions can now hold WebSockets. That could bring instant delivery, typing indicators and
live presence (R-011). D-004 rules out open connections because of the free plan's limits. Measure
what WebSockets cost on the Hobby plan before changing D-004.

### Q-2: One community per deployment?

Status: Open.

Everyone on a deployment can see everyone else (D-002). A student in several classes may want
separate spaces. Projects already group people. Is that enough, or should one deployment host
several communities?

### Q-3: Should the Pull requests pane move to the GitHub App too?

Status: Open.

Projects link repositories through a GitHub App since #17 (D-050). Each person's pane still uses
the OAuth App (D-032), with its polling, its scheduler and the `repo` scope (D-033, D-034). The
pane could use the same app: its webhooks would bring review requests at once, and it reads pull
requests only. Cost: the app only sees repositories it is installed on, so the pane would show
nothing from the others, such as a course repository whose organization never installed it. The
owner decided on 2026-11-01 to keep the OAuth App for the pane.

### Q-4: When does WebChat reach 1.0.0?

Status: Open.

WebChat stays at 0.y.z while it is in early development (D-055). Version 1.0.0 would promise that
no upgrade within 1.x needs a step from the person who runs it. Decide what must hold first, for
example an upgrade path that people who self-host can trust.

## Dropped

### R-001: Task board for projects, like Jira

Status: Dropped on 2026-11-04, replaced by R-021. The owner chose a board of decisions and roadmap cards, like this repository's own documents, over a Jira-style task board.

### R-023: Rebrand, step 2: a linear message feed instead of bubbles

Status: Dropped on 2026-11-05. #78 built it and reached main, and the owner reverted it: they prefer bubbles to a linear feed. D-084 is reverted.

R-024 to R-026, the rest of the rebrand, were dropped on 2026-11-05. The owner does not want
project-first navigation, new wording or a new name. The numbers stay taken.

### R-029: Hand a card to a teammate's agent

Status: Dropped on 2026-11-13. The owner no longer wants a teammate to run a card on someone else's agent. Since D-089 an agent runs only the cards its owner hands it, and that stays. The number stays taken.

### R-061: Run cards through a harness adapter, picked per session

Status: Dropped 2026-11-18: a duplicate of R-043, added from an old draft of docs/roadmap/new-harness-adapter.md.

Order: first. Three pull requests in a row, each merged before the next is claimed: the seam
alone, as a `refactor` with no change in behavior; then the sealed per-harness state and the
Settings rows; then the harness named in each signed request, with the pickers and the host
harness for unprompted turns. The seam's pull request also rewrites the "background Claude"
lines of `.claude/rules/projects.md` to "the harness's turn" and adds one line: an adapter owns
the turn, the isolation proof and the setup it offers, and `plugin.ts` never names a harness.
Every other card waits for the seam. The daemon host may start beside the second pull request.

Why: the agent's turn, its isolation proof and the setup it loads are Claude Code's command
line, settings files and hook format, in `agent/claude.ts` and `agent/plugin.ts`. The sealed
protocol, `Runs`, `Conversations` and the workflow in the plugin know no harness. A student
whose team uses Codex or OpenCode cannot run an agent at all.

Scope: one `Harness` interface in `agent/harness.ts` with three methods: `turn` runs one turn in
a folder with the brief on stdin and a JSON answer for a schema, `refusal` says why this laptop
cannot run cards with it, and `offers` names the instructions file, the skills folder and the
few knobs it can honor. The Claude adapter is today's code moved behind it, so a Claude Code
owner sees no change. Each harness the laptop found goes to the owner sealed in `SetupState`,
with its state and knobs, and Settings shows one row per harness with an enable toggle instead
of three hard-coded checkboxes. The owner names the harness, signed, in each card run and each
conversation, as the repository is named today (D-093): a second line in the card's play menu
and a picker beside the repository in the composer. No stored default; the page remembers the
last pick in the browser only. A session keeps the harness that started it, so fix rounds and
replies resume with the right one. Turns nobody picked for, "Check again" (D-116) and proposal
drafts (D-117), run on the host harness: Claude Code when the plugin hosts, the first enabled
harness when the daemon does. The check-in's level becomes the union over enabled harnesses.

Constraints: a knob is offered only when the adapter honors it without running code outside
the sandbox and without changing permission or sandbox mode; model, caps, the instructions
file, skills and attribution pass, and permission mode, plugins, hooks and MCP servers never do,
for any harness (D-097, D-115). The server learns nothing new: per-harness state is sealed to
the owner, and `claudeMd` keeps its wire name so old pages and plugins agree. A request from an
old page names no harness and runs on the host harness. A request naming a harness the laptop
has not enabled fails with the reason. No switching mid-session: another harness is a new
conversation. `test/agent.test.ts` gets a fixture per adapter, as `FAKE_CLAUDE` is one today.

Done when: a Claude Code agent behaves as before and the tests pass; Settings lists the
harnesses the laptop has, each with its state and knobs; a card run and a conversation each
show the harness the owner picked; a request from an old page runs on the host harness; a
request naming a harness that is not enabled fails with the reason.

## Done

| Work | Where |
| --- | --- |
| R-003: Add people to groups, who read the history (D-043) | #10 |
| R-002: New keys when someone leaves or is removed, leaving, handing over (D-044, D-045) | #13 |
| K-20: Drafts and unsent messages survive a closed tab (D-051) | #19 |
| K-22: The chat header stays in view over the iPhone keyboard (D-053) | #21 |
| K-25: The page no longer slides as the iPhone keyboard opens (D-053) | #22 |
| R-018: Alerts on iPhones without Web Push, through the Bark app (D-054) | #23 |
| K-7: A sync answer that breaks off no longer poisons the cursor (D-056) | #27 |
| K-5: GitHub alerts arrive with every tab closed, through Supabase Cron (D-057) | #29 |
| K-8: Message content is padded, so a ciphertext's length no longer shows a reaction (D-059) | #33 |
| K-6: The pane names an organization that hides its pull requests (D-060) | #34 |
| K-9: A retried send is stored once (D-061) | #35 |
| K-19: The push test searches the whole payload for the message | #41 |
| K-26: Messages from a checked security code open without a reload | #42 |
| K-12: A subscription with bad keys is refused or dropped, and no longer breaks pushes | #43 |
| K-15: A late sync answer no longer closes a chat just created (D-069) | #44 |
| K-16: A reaction push no longer shows or replaces a message notification (D-070) | #45 |
| K-10: `sslmode=disable` in `DATABASE_URL` turns TLS off | #46 |
| K-18: An expired session ends the browser's push subscription (D-072) | #47 |
| K-23: The banner says notifications need iOS 16.4 on older iPhones | #48 |
| K-17: Open pages pick up a push subscription the service worker replaced | #49 |
| K-13: The first key of a group checks its members under the group's lock | #50 |
| K-11: The New channel dialog and the server share one name rule (D-065) | #51 |
| K-14: Only failed sign-ins use up the limit for an address (D-068) | #52 |
| K-24: A chat's messages are sent one at a time, in the order they were written (D-075) | #53 |
| K-30: A session found expired at load forgets the keys on the device | #56 |
| K-29: The bell dialog hides "Turn on notifications" on iOS before 16.4 | #57 |
| K-35: The map of the code lists `client/src/queue.ts` | #58 |
| K-28: The New channel dialog wraps a long name at 375 pixels | #59 |
| K-33: The service worker deletes the push endpoint it replaced | #60 |
| K-32: Requests time out, so a send that never ends no longer blocks a chat (D-077) | #61 |
| K-31: `sameIds` refuses duplicates in both lists | #62 |
| K-27: The IPv6 loopback address gets no TLS | #63 |
| K-34: `shared/types.ts` says what it holds | #64 |
| K-21: An urgent message missed while every tab was closed rings when a page opens (D-078) | #65 |
| K-36: A deploy reloads a tab only when the page changes | #66 |
| K-37: Long names in dialog titles wrap on a phone | #67 |
| K-38: The map of the code lists every module | #68 |
| R-019: Urgent messages ring like an alarm with every tab closed (D-079) | #69 |
| K-39: A long message no longer lets the chat slide sideways on a phone | #70 |
| R-020: Shared Markdown docs in projects (D-081) | #73 |
| R-021: Project board of decisions and roadmap cards (D-082) | #75 |
| R-022: A work-tool palette and type, step 1 of the rebrand (D-083) | #77 |
| R-027: Run a card with a coding agent: headless client, run messages, Claude Code, busy flag, Codex and Hermes (D-085 to D-087) | #85, #86, #87, #88, #89 |
| K-41: An account from before the agent flag never becomes an agent | #91 |
| R-028: Delete an account (D-088) | #94 |
| K-42: The agent's allow list trusts the username the server sends (D-089) | #95 |
| K-45: Your own agent refuses a card a teammate wrote (D-089) | #95 |
| K-46: A card run hangs with no end when its daemon stops | #96 |
| R-030: Run cards from a Claude Code plugin (D-092, D-093) | #100 |
| K-47: The agent refuses a replayed request and a plain-HTTP server (D-093) | #100 |
| R-031: The pairing code carries the WebChat address (D-093) | #101 |
| R-032: Every open repository takes its own runs (D-094) | #104 |
| R-033: The owner removes an agent | #105 |
| K-48: The agent takes a plain http address under .localhost | #106 |
| K-49: Only a session that hears the doorbell takes runs (D-095) | #108 |
| R-034: The owner deletes a channel (D-096) | #110 |
| K-50: Only a session started for WebChat takes part (D-098) | #113 |
| R-035: A Coding agents pane where the owner talks with their agents (D-097, D-101 to D-105) | #114, #117, #119, #120, #121, #122 |
| K-51: A second request for a running card is refused (D-099) | #115 |
| K-52: A card shows its latest run, and Run waits while it goes (D-100) | #116 |
| Q-5: Does a resumed Claude Code session hear the plugin's doorbell? | #117 |
| K-53: The plugin refuses runs until the sandbox denies the keychain and session-env and fails if unavailable; the guard resolves links as the kernel does | #118 |
| K-58: The plugin unwatches a draft from before D-105 that the pane cannot show | #127 |
| R-037: An agent runs several cards at once (D-085, D-086, D-099) | #130 |
| R-036: One Claude Code window serves every repository, and the agent clones on its owner's click (D-094, D-101, D-108) | #131 |
| R-038: The Coding agents pane lists projects, and a conversation belongs to one (D-102, D-103) | #132 |
| K-60: A deploy reload closes an open board | #135 |
| K-61: The pairing poll stops for good on the first failed request | #136 |
| K-62: A reload leaves the sidebar on Chats while a board or doc is open | #140 |
| K-63: A reload closes the editor of a board card or doc section | #141 |
| K-59: Two agents can run one card at once | #143 |
| K-44: A reply or reaction follows the message id, which no signature covers | #144 |
| K-57: The agent never pins a teammate's new keys, so Start fails on a board with their text | #145, #122 |
| K-40: The keyring logic exists twice, in the page and in the agent | #147, #85 |
| K-43: A chat key's wrap does not name its chat | #150, #146 |
| K-64: A running card on the board has no Stop | #151 |
| K-65: A chat key copy from before D-111 can still be moved to another chat | #152, #150 |
| K-66: The agent has no off switch, and a hidden window takes over | #153 |
| K-67: An owner can hand a project or group to an agent | #154 |
| K-68: A new card on the board cannot be cancelled | #163 |
| R-039: The owner chooses what their agent's runs load from their Claude setup | #165, #159 |
| R-041: The agent checks a new card, and the board numbers it | #166 |
| R-040: The board is the source of truth, and the repository follows it | #167, #159 |
| R-042: A card run follows the repository's workflow | #168 |
| K-79: An agent's draft can give a card two status lines | #171 |
| K-84: A card stays In review after its run's draft is closed unmerged | #171 |
| R-043: Run cards through a harness adapter, picked per session | #174, #176, #179 |
| R-062: Serve the agent from a daemon as well as from the plugin | #177 |
| R-057: Pause a run and redirect it | #178, #181, #182, #174 |
| R-065: The roadmap as lanes, with a card owner who holds its gates | #188, #189, #190 |
| Q-7: Should a card run stop needing the owner's gh token? | #193 |
| K-82: The flipped-ciphertext test fails about once in 4,000 runs | #194 |
| K-83: A linked repository's copy shows a status that does not stand | #195 |
| K-86: An editor in the board's hidden tab loses its lock unseen | #196 |
| K-85: A hand edit of a card can drop or revive a review line | #197 |
| K-69: An agent's board messages buzz the owner's phone and count as unread | #198, #167 |
| R-068: Ship the agent as one file per OS from GitHub releases | #199 |
| R-066: Set up the agent with one command | #200 |
| R-059: Link harnesses from the list WebChat supports | #201 |
| R-063: Connect a folder only on the owner's approval in WebChat | #202 |
| R-069: Run ACP agents from a shipped list through one adapter | #203 |
| R-060: Approve a harness's actions from WebChat | #204 |
| R-058: Keep the agent's secrets in a locked room | #206, #207, #208, #209 |
| R-067: The agent updates itself to its server's release | #210 |
| K-72: The board does not show the proposals that wait for it | #222 |
| K-70: The pane says "No copy yet" for a repository the agent works in | #223 |
| K-71: A backlog of proposal files hits the send limit, and a new install sends them all again | #224 |
| R-044: Make and number a card from the terminal | #225 |
| R-045: R-045: The Coding agents row's name says nothing of board work | #227 |
| K-1: The iOS 16.4 banner stays after Bark is linked | #228 |
| K-73: The owner is asked about shell commands the sandbox already holds | #233 |
| R-046: A run checks its work in a browser that reaches only its own dev server | #235, #240 |
| R-055: Support Hermes as a harness | #243 |
| R-054: Support Antigravity as a harness | #244 |
| R-052: Try the Astryx design system on the sign-in screen | #247 |
| R-053: Move every screen to Astryx | #248, #252 |
| R-047: A card opens as a peek that holds its run | #257, #259, #272, #274 |
| R-051: CI fails a pull request that overlaps an earlier open one | #260 |
| R-050: Split the files that every card edits | #261, #263, #270 |
| K-75: Two claims seconds apart both get the item | #271 |
| R-049: A run waits when its files overlap a running card's | #276 |
| R-048: A card waits for the cards it names | #277 |
| K-76: Older copies of a proposal wait on the board for good | #280 |
| K-78: A proposal draft older than the newest 50 messages never reaches the board | #283 |
| R-072: The member's own harness, with its whole session shown, in WebChat | #284, #285, #287, #288, #289 |
| R-071: A card from a harness session, and a prompt box in the new card form | #286 |
| K-74: An agent's card draft loses everything past 4,000 characters | Fixed |
