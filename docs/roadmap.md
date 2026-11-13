# Roadmap

This file is a copy of the Roadmap column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes a new entry as a file under `docs/roadmap/`, named by a short name such as `new-bark-banner.md`, or a change to one as `docs/roadmap/K-12.md`.

## Running

### R-045: The Coding agents row's name says nothing of board work

Status: In review: Hzxon/webchat#227.

Checked: 2026-11-13. Read K-72 and its fix on this branch (waitingProposals, BoardView), AgentsView.tsx thread subtitles, D-103, D-104 and D-117, and the cards K-69, K-70, K-71 and R-044 at 8f66355. Open pull requests not read: gh cannot run in this sandbox.

Why: proposal drafts from a linked repository (D-117) sit in threads under Chats, in the row "Coding agents", named `Proposed in <repo>: <file>`. An owner who looks for board work does not think of that row. K-72 points the owner's board at the drafts, but the row itself still reads as chats with an agent only.

Scope: make the row's subtitle, or its badge, say when proposals wait, such as "3 proposals wait", using the same count the board shows (`waitingProposals` in `client/src/agents.ts`). Nothing new reaches the server.

Done when: with a proposal draft not yet added, the Coding agents row says so, and it stops once the draft is added.

### K-1: The iOS 16.4 banner stays after Bark is linked

Status: Running: Jiro’s agent.

Checked: 2026-11-13. Read the board's K-1, the other cards and the held decisions (D-004, D-021, D-054, D-100, D-118); Sidebar.tsx, NotificationDialog.tsx, push.ts, store.ts, AgentDraft.tsx, otherRun in client/src/board.ts, docs/roadmap/K-1.md and revert-reopens-card.md on main at eb8c3c4. Open pull requests #227, #226 and #184 read by title only.

Found by the owner on an iPhone before iOS 16.4. #159 fixed it and #169 reverted it, so the card is open again and main still has the bug (checked at eb8c3c4).

Before a run: set the status line to `Open` by hand. It still says `In review: Hzxon/webchat#159`, and the brief refuses any card whose status starts with `In review` (`otherRun` in `client/src/board.ts`). A draft cannot change it: a change keeps the status as written (`AgentDraft.tsx`). The general fix, a merged revert that reopens its card, is the proposal `docs/roadmap/revert-reopens-card.md`.

On iOS before 16.4 the sidebar always shows "Notifications on iPhone need iOS 16.4. Tap to get alerts through the Bark app instead." It stays after the user links Bark and their alerts already arrive through it. A warning that never goes away teaches people to ignore the banner, and it suggests that their alerts are broken when they are not.

Cause: `AlertSetupBanner` in `client/src/components/Sidebar.tsx` shows the warning while `push.permission !== 'granted'`. That can never change on these phones, which have no Web Push (`oldIos` in `client/src/push.ts`). The page never asks whether Bark is linked. Only `NotificationDialog` fetches `GET /api/bark` (`BarkDTO`), into its own state, and only while the dialog is open (D-054).

Fix: on iOS before 16.4, the page keeps the Bark state in the store and hides the warning once `link.devices` has at least one phone. While Bark is linked but no phone has registered, the warning stays, since nothing reaches the user yet. Other browsers keep their banner, and the alert sound banner is unchanged.

Constraint: Bark link state is not in the sync fingerprint (D-054, D-021), and a fetch on every check-in would go against D-004. So the page fetches `GET /api/bark` once at load, only on these phones, and the dialog writes each answer it gets into the store. A phone that registers in Bark while the page stays open hides the warning at the next load, or when the dialog is opened or refreshed.

Why #169 reverted #159 is not recorded in the repository. R-039, R-040 and R-042 name process faults in #159: it took the board's K-1 while the repository used that number for another item, its body carried an AI attribution line, and 116 tests were cancelled. That suggests the revert was about process and not the fix, but it is an inference. Read #169 on GitHub before taking the card again.

Done when: an iOS 15 user agent with a linked Bark device shows no notification warning, one without a link or device still shows it, and a test proves both. `npm test` has no DOM, so the choice of banner is a pure function that the test calls, as `iosVersion` in `client/src/ios.ts` is tested in `test/ios.test.ts`.

## Ready

### R-005: Photos and files

Status: Planned.

Why: students share drafts, slides and screenshots. WebChat sends text only.

Scope: the browser encrypts each file with a key of its own and uploads only the ciphertext. The
message carries the file's address and key inside its envelope.

Constraints: Vercel Functions accept request bodies of at most 4.5 MB, so files go from the browser
straight to a storage service, such as Vercel Blob with private access. The Content Security Policy
allows connections only to the site itself, so it must also allow the storage service (D-009).

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

### R-029: Hand a card to a teammate's agent

Status: Planned. Set aside from K-45 (D-089) on 2026-11-05.

Why: since D-089 an agent runs only the cards its owner hands it. A team with one agent and
a teammate who has none cannot share it, and a student who runs an agent cannot let a teammate
start a run while they are away.

Scope:

- The play button also lists teammates' agents that are online, named by owner, such as
  "Bob's claude-code", and only those whose owner lets the viewer use them.
- The owner lets a teammate in from the daemon, which stores the teammate's user id with their
  pinned keys and prints the security code to compare (D-018). The check K-42 asked for holds: a
  username alone never lets anyone in.
- Decide what a teammate's request may put in the prompt: the card as the teammate saw it, pinned
  by a hash in the signed request, and the decisions.
- Maybe: the daemon writes the branch into the card's status line, and posts sparse progress notes.

Done when: a teammate's request runs on the owner's machine only after the owner let them in, and a
test covers a request from someone who was not let in.

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

### R-043: Run cards through a harness adapter, picked per session

Status: Idea.

Checked: 2026-11-09. Read docs/roadmap/new-harness-adapter.md, agent/harness.ts, agent/claude.ts, agent/codex.ts and CHANGELOG 0.9.0 (#176, #179) on main at 6a95ad6, and the board's cards and decisions. No open pull requests.

Shipped in #174 (the seam), #176 (the sealed per-harness state and the Settings rows) and #179 (the harness named in each signed request). Proposed 2026-11-09 from the harness audit.

Why: the agent's turn, its isolation proof and the setup it loads were Claude Code's command line, settings files and hook format, in `agent/claude.ts` and `agent/plugin.ts`. The sealed protocol, `Runs`, `Conversations` and the workflow in the plugin know no harness. A student whose team uses Codex or OpenCode could not run an agent at all.

Scope:

- One `Harness` interface in `agent/harness.ts`. `turn` runs one turn in a folder with the brief on stdin and a JSON answer for a schema. `refusal` says why this laptop cannot run cards with it. `offers` names the instructions file, the skills folder and the few knobs it can honor. The Claude adapter is the old code moved behind it, so a Claude Code owner sees no change.
- Each harness the laptop found goes to the owner sealed in `SetupState`, with its state and knobs. Settings shows one row per harness with an enable toggle.
- The owner names the harness, signed, in each card run and each conversation, as the repository is named (D-093). A session keeps the harness that started it. Turns nobody picked for run on the host harness.
- The seam's pull request rewrote the "background Claude" lines of `.claude/rules/projects.md` to "the harness's turn": an adapter owns the turn, the isolation proof and the setup it offers, and `plugin.ts` never names a harness.

Constraints: a knob is offered only when the adapter honors it without running code outside the sandbox and without changing permission or sandbox mode. Model, caps, the instructions file, skills and attribution pass. Permission mode, plugins, hooks and MCP servers never do, for any harness (D-097, D-115). The server learns nothing new: per-harness state is sealed to the owner, and `claudeMd` keeps its wire name. A request from an old page names no harness and runs on the host harness. A request naming a harness that is not enabled fails with the reason. No switching mid-session. `test/agent.test.ts` has a fixture per adapter.

Done when: a Claude Code agent behaves as before and the tests pass; Settings lists the harnesses the laptop has, each with its state and knobs; a card run and a conversation each show the harness the owner picked; a request from an old page runs on the host harness; a request naming a harness that is not enabled fails with the reason.

## Known issues

### K-69: An agent's board messages buzz the owner's phone and count as unread

Status: Open. Found on 2026-11-07 in the review of #167 (R-040).

Seen: when the owner links a board, their agent sends the repository's entries in several messages.
It also sends one each time the cards that open pull requests claim change. Each is an ordinary
message in the owner's direct chat with the agent. The server pushes it and counts it as unread, so
the Coding agents row shows a badge, and a phone whose tabs are closed buzzes. The page only keeps
them from raising a toast (`shouldAlert` in `client/src/chat.ts`).

Cause: the server knows the message kinds message, reaction and github, and only a reaction stays
quiet (`server/notify.ts`, and the unread counts in `server/db.ts`).

Fix: a quiet message kind, such as `sync`, that the server pushes and counts as it does a reaction,
and that the agent sends its entries and claims with. A message's kind is signed into its envelope,
so rule 2 of AGENTS.md holds.

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

### Q-5: Does a resumed Claude Code session hear the plugin's doorbell?

Status: Answered in #117. The doorbell and the monitor are gone. A resumed session starts the plugin's server again, which takes runs as any session does.

The plugin's monitor tails the doorbell for as long as the session runs (R-030). Claude Code's docs
say a resumed session does not restore background tasks, and do not say whether a plugin's monitor
starts again. Try `claude --resume` on a session with the plugin, and hand it a card. If the monitor
is gone, a run fails after 30 minutes (D-094), so the README should say to start a new session.

## Dropped

### R-001: Task board for projects, like Jira

Status: Dropped on 2026-11-04, replaced by R-021. The owner chose a board of decisions and roadmap cards, like this repository's own documents, over a Jira-style task board.

### R-023: Rebrand, step 2: a linear message feed instead of bubbles

Status: Dropped on 2026-11-05. #78 built it and reached main, and the owner reverted it: they prefer bubbles to a linear feed. D-084 is reverted.

R-024 to R-026, the rest of the rebrand, were dropped on 2026-11-05. The owner does not want
project-first navigation, new wording or a new name. The numbers stay taken.

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
| K-72: The board does not show the proposals that wait for it | #222 |
| K-70: The pane says "No copy yet" for a repository the agent works in | #223 |
| K-71: A backlog of proposal files hits the send limit, and a new install sends them all again | #224 |
| R-044: Make and number a card from the terminal | #225 |
