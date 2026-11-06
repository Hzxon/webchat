# Roadmap

This file lists the work that is planned or set aside, the known issues, and the questions that
are still open. Read it before you start new work. When someone asks what to do next, start with
the items under "Next". The decisions these items build on are in [decisions.md](decisions.md).

## How to use this file

- Features and other work are R-items, known issues are K-items, and open questions are Q-items.
  Numbers never change and are never reused.
- Each item says why it matters, what it covers, and when it is done. Write open questions under
  the item they belong to.
- Status values: Next, Planned, Idea, Blocked, In progress, Done, and Dropped.
- When you start an item, set it to "In progress" and name your branch. When it reaches main, the
  pull request sets its status to "Done" or "Fixed" with the pull request number, in place, and
  records its decisions in `decisions.md`. The entry stays where it is. A housekeeping pull request
  deletes the finished entry and adds its row to the Done table, so that two fixes never edit the
  same lines (D-076). Until then the Done table lags, and
  `grep -n '^Status: \(Done\|Fixed\)' docs/roadmap.md` lists what is finished.
- A new entry starts as its own file, `docs/roadmap/K-59.md`, in the same form as an entry here,
  so that two pull requests never insert at the same spot (D-106). Edit its status line there.
  The housekeeping pull request moves it into this file. `ls docs/roadmap` lists what is pending.
- When you drop an item, keep it, set it to "Dropped", and say why.

## Next

Nothing is queued. The owner picks the next item from Planned.

## Planned

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

### R-016: Link a project to repositories

Status: Planned. Started in #14. Since #17 (D-050), a project links repositories through a
GitHub App, and its webhooks post a card into the channel for every pull request that opens, is
ready for review, is reopened, merged or closed. Still to do: the Projects tab list, reviewers
shown by their WebChat names instead of GitHub logins, and cards that show a pull request's
current checks and review decision instead of a snapshot.

Why: the pane lists one person's pull requests across every repository, with no grouping. A team
wants to see every open pull request of its repositories, by any member, next to its channels. Only
pull requests are watched today: pushes and commits are not, and teams that push to main see
nothing.

Scope: a project names one or more repositories. The Projects tab shows their open pull requests,
grouped by repository. Reading them needs the GitHub App's installation token, which needs the
app's private key on the server (D-050 keeps no token).

Settled in D-050: every pull request in a linked repository goes to the channel, whoever opens it.
Everyone in the project sees its title, even without access to the repository, so the list here
would show the same to the whole project.

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

## Known issues

### K-59: Two agents can run one card at once

Status: Open. Found on 2026-11-06 while reading `client/src/components/BoardView.tsx` for the
design of R-036 to R-038.

The board disables a card's play button only from the viewer's own run messages (D-100,
`BoardView.tsx` where `cardRun` sets `disabled`). Teammates see no run messages, so their button
stays enabled while the status line says `In progress: Ann's agent`, and the brief (D-105) does not
refuse either. A teammate with an agent of their own can start the same card: two branches, two
drafts, one card.

Fix: the brief refuses, or at least warns, when the card's status line names another agent's run,
such as `In progress:` or `In review:`, since the status line is the one thing teammates can see
(D-100). A refusal is enough; a lock would need the server to know what the request names, which
it cannot (D-014).

### K-57: The agent never pins a teammate's new keys, so Start fails on a board with their text

Status: Open. Found in the correctness review of R-035's step 6 (#122) on 2026-11-06, and left open
because it is rare: it needs a teammate whose keys changed.

Until the owner checks a teammate's new security code, nothing signed with their keys opens (D-018).
The owner's page and the agent both leave out the teammate's board sections, so both hash the same
brief (D-105). Once the owner checks the code, the page opens those sections and puts them in the
brief. The agent still leaves them out, so the two hashes differ from then on. A decision that the
teammate wrote and the team still holds is part of every card's brief on that board, so every Start
there fails with "The card or a decision changed since you opened it." A card the teammate wrote
fails with "I can’t find that card on the board anymore."

The agent pins a person's keys the first time it sees them and never again (`checkKeys` in
`agent/client.ts`). The page pins again when the owner checks a code (`trust` in
`client/src/e2ee/keyring.ts`), and the agent has no such step. So `keysOf` keeps answering null for
the new keys, and `sections` leaves the teammate's text out of the brief that `handle` in
`agent/runs.ts` hashes. The page hashes what opens for it (`AgentBrief.tsx`). This is the split that
K-40 warns of.

Fix: when the owner checks a teammate's code, the page sends each of their agents a message that
names the person and the fingerprint it checked. An agent pins it only when its owner sent it, with
a signed send time and once per client id (D-089, K-47), and only when it is the person's current
fingerprint.

### K-44: A reply or reaction follows the message id, which no signature covers

Status: Open. Found in a security review of main on 2026-11-05.

A reply signs its original's id, sender and quoted text. But `Quote` in
`client/src/components/ChatView.tsx` shows whatever message now has that id, and never compares
it with the signed quote. Reactions are filed under the id the same way (`client/src/store.ts`).
The id is the server's primary key and is in no signature (D-016). So someone who writes to the
database can swap the ids of two messages from one sender in one chat. A signed "Yes, do it" then
answers the other question. The swap also reorders the two messages, which shows.

Fix: show the original only when its sender and text match the signed quote, and the signed quote
otherwise. Bind a reaction to something its target's sender signed, such as the client id.

### K-43: A chat key's wrap does not name its chat

Status: Open. Found in a security review of main on 2026-11-05.

`pairKey` in `shared/e2ee.ts` binds the key id and the two users into the wrap, but not the
conversation. The key link binds it. The only check that a replaced key never encrypts again
reads `keyLinks`, which come from the server (`client/src/e2ee/keyring.ts`). So someone who writes
to the database can restore a chat's old key and delete its link. Members then send with a key
that a removed member still holds, which breaks the promise that they never get what is sent
after they left. The README already accepts that the server picks who gets a rotated key, which is
a stronger attack, so this adds little on its own.

Fix: add the conversation id to the wrap's HKDF info and AAD under a v2 label, so old wraps still
open. Remember on each device the newest key id per chat, and refuse to seal with an older one.

### K-40: The keyring logic exists twice, in the page and in the agent

Status: Open. Found while building R-027 step 1 (#85).

`agent/client.ts` ports `chatKey`, `keyFor`, the key cache, the pins and the signature checks
from `client/src/e2ee/keyring.ts`, because that module reaches into IndexedDB and cannot load in
Node. The two copies decide the same security questions: whether a member wrapped the chat key,
that a replaced key never encrypts again, and whose changed keys to refuse (D-015, D-018). A fix
in one copy is easy to forget in the other.

Fix: move the pure logic into a module under `shared/` that takes the key lookup, a key cache
and a pin store as arguments, with the page passing IndexedDB and the agent its account file.
Until then, a change to either copy must be made in both.

## Open questions

### Q-1: Should updates move to WebSockets?

Vercel Functions can now hold WebSockets. That could bring instant delivery, typing indicators and
live presence (R-011). D-004 rules out open connections because of the free plan's limits. Measure
what WebSockets cost on the Hobby plan before changing D-004.

### Q-2: One community per deployment?

Everyone on a deployment can see everyone else (D-002). A student in several classes may want
separate spaces. Projects already group people. Is that enough, or should one deployment host
several communities?

### Q-3: Should the Pull requests pane move to the GitHub App too?

Projects link repositories through a GitHub App since #17 (D-050). Each person's pane still uses
the OAuth App (D-032), with its polling, its scheduler and the `repo` scope (D-033, D-034). The
pane could use the same app: its webhooks would bring review requests at once, and it reads pull
requests only. Cost: the app only sees repositories it is installed on, so the pane would show
nothing from the others, such as a course repository whose organization never installed it. The
owner decided on 2026-11-01 to keep the OAuth App for the pane.

### Q-4: When does WebChat reach 1.0.0?

WebChat stays at 0.y.z while it is in early development (D-055). Version 1.0.0 would promise that
no upgrade within 1.x needs a step from the person who runs it. Decide what must hold first, for
example an upgrade path that people who self-host can trust.

### Q-5: Does a resumed Claude Code session hear the plugin's doorbell?

Status: Answered in #117. The doorbell and the monitor are gone. A resumed session starts the
plugin's server again, which takes runs as any session does.

The plugin's monitor tails the doorbell for as long as the session runs (R-030). Claude Code's docs
say a resumed session does not restore background tasks, and do not say whether a plugin's monitor
starts again. Try `claude --resume` on a session with the plugin, and hand it a card. If the monitor
is gone, a run fails after 30 minutes (D-094), so the README should say to start a new session.

## Dropped

Work the owner decided against. The entries keep their numbers and say why.

### R-001: Task board for projects, like Jira

Status: Dropped on 2026-11-04, replaced by R-021. The owner chose a board of decisions and
roadmap cards, like this repository's own documents, over a Jira-style task board.

### R-023: Rebrand, step 2: a linear message feed instead of bubbles

Status: Dropped on 2026-11-05. #78 built it and reached main, and the owner reverted it: they
prefer bubbles to a linear feed. D-084 is reverted.

R-024 to R-026, the rest of the rebrand, were dropped on 2026-11-05. The owner does not want
project-first navigation, new wording or a new name. The numbers stay taken.

## Done

Finished work. The table is the index; git history keeps each entry's reasons and pull requests.
Nothing here is a candidate for what to do next.

| Work | Where |
| --- | --- |
| Chat with push notifications and urgent alerts | 74d53ff |
| End-to-end encryption | 10ba6d8 |
| Tabs keep to the account they show | b75d690 |
| GitHub pull requests | #1 |
| Projects with channels, replies and reactions | #2 |
| Owners remove members and delete projects and groups | #4 |
| Known issues K-1 to K-4: reload after deploy, dialog focus, Node version, member order | #6 |
| Share a pull request into a chat as a card | #8 |
| R-003: Add people to groups, who read the history (D-043) | #10 |
| R-002: New keys when someone leaves or is removed, leaving, handing over (D-044, D-045) | #13 |
| New pull requests shared into linked projects; cards name the reviewers (D-046) | #14 |
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
| One account per device (D-080) | #71 |
| R-020: Shared Markdown docs in projects (D-081) | #73 |
| R-021: Project board of decisions and roadmap cards (D-082) | #75 |
| R-022: A work-tool palette and type, step 1 of the rebrand (D-083) | #77 |
| R-027: Run a card with a coding agent: headless client, run messages, Claude Code, busy flag, Codex and Hermes (D-085 to D-087) | #85, #86, #87, #88, #89 |
| K-41: An account from before the agent flag never becomes an agent | #91 |
| R-028: Delete an account (D-088) | #94 |
| K-42: The agent's allow list trusts the username the server sends (D-089) | #95 |
| K-45: Your own agent refuses a card a teammate wrote (D-089) | #95 |
| K-46: A card run hangs with no end when its daemon stops | #96 |
| K-47: The agent refuses a replayed request and a plain-HTTP server (D-093) | #100 |
| R-030: Run cards from a Claude Code plugin (D-092, D-093) | #100 |
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
| K-53 to K-56: The plugin refuses runs until the sandbox denies the keychain and session-env and fails if unavailable; the guard resolves links as the kernel does | #118 |
| K-58: The plugin unwatches a draft from before D-105 that the pane cannot show | #127 |
| R-037: An agent runs several cards at once (D-085, D-086, D-099) | #130 |
| R-036: One Claude Code window serves every repository, and the agent clones on its owner's click (D-094, D-101, D-108) | #131 |
| R-038: The Coding agents pane lists projects, and a conversation belongs to one (D-102, D-103) | #132 |
