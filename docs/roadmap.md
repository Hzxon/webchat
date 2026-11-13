# Roadmap

This file is a copy of the Roadmap column of the project's board in WebChat, which its owner's agent writes. Do not edit it by hand: a pull request proposes a new entry as a file under `docs/roadmap/`, named by a short name such as `new-bark-banner.md`, or a change to one as `docs/roadmap/K-12.md`.

## Running

### R-045: The Coding agents row's name says nothing of board work

Status: In review: Hzxon/webchat#227.

Checked: 2026-11-14. Read R-045, K-69, K-72 and the other cards, D-103, D-104, D-116 and D-117; Sidebar.tsx, agents.ts, AgentDraft.tsx, test/agents.test.ts and CHANGELOG 0.11.0 on main at e7bdfac, which has the change from #227; open pull requests #228 and #229 by title only. Tests not run.

Why: proposal drafts from a linked repository (D-117) sit in threads under Chats, in the row "Coding agents", named `Proposed in <repo>: <file>`. An owner who looks for board work does not think of that row. K-72 points the owner's board at the drafts, but the row itself still read as chats with an agent only.

Scope: the row's subtitle says when proposals wait, such as "3 proposals wait for the board" (`AgentsListItem` in `client/src/components/Sidebar.tsx`). The row is not tied to one project, so it counts the waiting drafts of every project with `proposalsWaiting` in `client/src/agents.ts`, while the board counts its own with `waitingProposals` (K-72). The unread badge stays the agents' chats' (D-103). Nothing new reaches the server.

Done when: with a proposal draft not yet added, the Coding agents row says so, and it stops once the draft is added. `test/agents.test.ts` proves the count.

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

### R-046: A run checks its work in a browser that reaches only its own dev server

Status: Idea.

Checked: 2026-11-14. Read the board's cards and decisions (D-037, D-080, D-097, D-118, K-73), docs/decisions/new-sandbox-owned.md and locked-room.md, docs/roadmap/ and AGENTS.md, and grepped for chrome-devtools, Playwright and Puppeteer, on main at bb44370; open pull requests #233 and #229 by title only; tests not run.

Order: after K-73 (#233).

Why: AGENTS.md asks for a browser check with two accounts, at desktop width and 375 pixels, in
light and dark, and for screenshots in the pull request. A run cannot do either. Its tools are the
shell, the file tools, web search and web fetch (`agent/claude.ts`), its only MCP server is the
approval tool, and its shell reaches only the npm registry. So the owner does the visual check by
hand, and the model never sees what it built.

Scope:

- The runner adds `chrome-devtools-mcp` to the `--mcp-config` file, beside the approval tool. Setup
  installs one pinned version; a run never fetches it. It runs headless with a temporary profile,
  never the owner's, and with usage statistics, CrUX lookups, update checks and `file:` navigation
  off. It launches Chrome itself, so no debugging port is open for the shell to drive.
- Chrome sends every request, loopback included, through a proxy in the runner. The proxy passes
  only `localhost` names and loopback addresses, on the ports the run's dev server opened.
- The rulebook allows a named list of the server's tools: pages, input, resize and emulate, the
  snapshot, the screenshot, console and network lists, and script evaluation. Any other tool is
  refused, so a new version adds nothing silently. A `url` must be loopback on a run port. An
  argument that names a file, such as `filePath` or `filePaths`, is judged as a path, so it stays
  in the working folders.
- The runner starts the dev server, not the model's shell, as the owner decided on 2026-11-14. The
  model asks for it through a tool of WebChat's own, naming the command. The runner picks free
  ports, so two runs do not clash on 3000 and 5173, and runs the command in a sandbox it owns: it
  writes only the working folder, binds only those ports, and connects to nothing but them. It
  ends with the turn.
- Screenshots go back to the model and, sealed, to the owner in the run's thread. The pull request
  says they are there.

Constraints: screenshots are content, so they travel sealed (rule 1). The dev server is the
model's code, so the runner never starts it as a plain process of the owner: that would run a
teammate-steered model's code outside every sandbox. Claude Code's own sandbox cannot hold it
either: its `network.allowLocalBinding` opens every loopback port of the laptop, such as another
project's dev server or a local database, and does nothing on Linux, where a sandboxed command's
`localhost` is private to it (code.claude.com/docs/en/sandboxing, read 2026-11-13). So the runner's
sandbox names the ports: a profile of WebChat's own on macOS, and on Linux a network namespace
that the dev server and the browser share. The model's shell keeps no local network, so it checks
the server through the browser's tools, not `curl`. Web Push cannot be tested, since it needs a
push service outside the laptop. Claude Code only: Codex and ACP agents need the same filter by
another route.

Cost: a sandbox WebChat owns and must keep working on two systems, which
docs/decisions/new-sandbox-owned.md once dropped. A dependency to pin and watch, with 63 tools at
this reading, of which the default set goes into every turn's context. A Chrome per run, a few
hundred MB of memory, started at first use and ended with the turn.

Done when: on macOS, a card run that changes the client starts the dev server, opens it as two
accounts on `alice.localhost` and `bob.localhost`, and the owner gets screenshots at desktop width
and 375 pixels, light and dark, with no question asked; tests show the proxy refusing another host
and another port, the dev server failing to reach a port that is not its own, and the rulebook
refusing a `file:` URL, a file path outside the folder and a tool off the list.

## Known issues

### K-69: An agent's board messages buzz the owner's phone and count as unread

Status: Open. Found on 2026-11-07 in the review of #167 (R-040).

Checked: 2026-11-14. Read K-69 and the other cards, the held decisions (D-016, D-020, D-030, D-117), docs/roadmap/K-69.md, docs/decisions/quiet-sync-messages.md and D-020.md, server/notify.ts, bark.ts, api.ts, db.ts, migration 23, agent/client.ts, sw.ts and the tests on main at 040ba5d; tests not run. Open pull request #229 read by title only.

Main has the fix since #198 (checked at 040ba5d). Set the status line to `Fixed in Hzxon/webchat#198` by hand, or add the proposal from `docs/roadmap/K-69.md`, which carries that status: a draft from a conversation keeps the status as written.

Seen: when the owner links a board, their agent sends the repository's entries in several messages. It also sends one each time the cards that open pull requests claim change. Each was an ordinary message in the owner's direct chat with the agent. The server pushed it and counted it as unread, so the Coding agents row showed a badge, and a phone whose tabs were closed buzzed. The page only kept them from raising a toast (`shouldAlert` in `client/src/chat.ts`).

Cause: the server knew the message kinds message, reaction and github, and only a reaction stayed quiet (`server/notify.ts`, and the unread counts in `server/db.ts`).

Fix: a quiet message kind, `sync` (`MessageKind` in `shared/types.ts`, migration 23). The server pushes and counts it as it does a reaction (D-030): no push unless the owner looks at a tab, no Bark alert, never unread, and no new chat preview (`server/notify.ts`, `server/bark.ts`, `server/db.ts`, `client/src/sw.ts`). It refuses an urgent one (`server/api.ts`). The agent sends its entries, claims and failed links with it, and a proposal stays an ordinary message, since it is news to the owner (`send` in `agent/client.ts`). Against a server that answers `Unknown message kind.`, the agent sends the message as before. The kind is signed into the envelope (D-016), so rule 2 of AGENTS.md holds.

Decision: the quiet-sync decision, Proposed in #198 as `docs/decisions/quiet-sync-messages.md`, is not on the board yet and has no number. The server now sees which messages are board traffic; `docs/decisions/D-020.md` adds that to D-020, and the board's D-020 does not have the line yet.

Tests: `test/chat.test.ts` (no push, never unread, no new preview, never urgent) and `test/agent.test.ts` (entries and claims go as `sync`).

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

### R-029: Hand a card to a teammate's agent

Status: Dropped on 2026-11-13. The owner no longer wants a teammate to run a card on someone else's agent. Since D-089 an agent runs only the cards its owner hands it, and that stays. The number stays taken.

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
| K-1: The iOS 16.4 banner stays after Bark is linked | #228 |
| K-73: The owner is asked about shell commands the sandbox already holds | #233 |
