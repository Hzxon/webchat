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
- When you drop an item, keep it, set it to "Dropped", and say why.

## Next

### R-001: Task board for projects, like Jira

Status: Dropped on 2026-11-04, replaced by R-021. The owner chose a board of decisions and
roadmap cards, like this repository's own documents, over a Jira-style task board.

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

### R-022: Rebrand, step 1: a work-tool palette and type

Status: In progress on branch `claude/r022-work-tool-palette` (D-083). First of two steps that
move WebChat from a WhatsApp look to a Slack-like workspace (R-022 and R-023).

Why: the features are for serious project work, but the page looks like a consumer messenger.
`client/src/styles.css` copies WhatsApp's palette (`--accent: #00a884`, `--bubble-out: #d9fdd3`,
`--text: #111b21`), its 10px radius and its 15px type, so the product reads as a WhatsApp clone
before anyone sees a project.

Scope:

- A neutral gray scale with one accent that is far from teal, such as indigo. Danger and warn stay.
- A tinted or dark sidebar with a white content area, flat panels with 1px lines, and no card
  shadow on panels.
- 14px base type with a tighter line height, monospace for inline code, 6px radius everywhere, and
  square-ish avatars.
- Light and dark mode, both checked at desktop width and at 375 pixels.

Constraints: this step changes `styles.css` only, with no change in behavior or markup. The file is
over 2,600 lines, so expect to touch more selectors than the token list suggests.

Done when: the page shows no WhatsApp color, every screen passes the two-account check in both
modes and both widths, and the owner has approved screenshots.

### R-023: Rebrand, step 2: a linear message feed instead of bubbles

Status: Dropped on 2026-11-05. #78 built it and reached main, and the owner reverted it: they
prefer bubbles to a linear feed. D-084 is reverted.

R-024 to R-026, the rest of the rebrand, were dropped on 2026-11-05. The owner does not want
project-first navigation, new wording or a new name. The numbers stay taken.

### R-029: Hand a card to a teammate's idle agent

Status: Planned. Set aside from K-45 (D-089) on 2026-11-05.

Why: since D-089 an agent runs only the cards its owner hands it. A team with one free agent and
a teammate who has none cannot share it, and a student who runs an agent cannot let a teammate
start a run while they are away.

Scope:

- The play button also lists teammates' agents that are online and idle, named by owner, such as
  "Bob's claude-code", and only those whose owner lets the viewer use them.
- The owner lets a teammate in from the daemon, which stores the teammate's user id with their
  pinned keys and prints the security code to compare (D-018). The check K-42 asked for holds: a
  username alone never lets anyone in.
- Decide what a teammate's request may put in the prompt: the card as the teammate saw it, pinned
  by a hash in the signed request, and the decisions.
- Maybe: the daemon writes the branch into the card's status line, and posts sparse progress notes.

Done when: a teammate's request runs on the owner's machine only after the owner let them in, and a
test covers a request from someone who was not let in.

### R-030: Run cards from a Claude Code plugin

Status: In review in #100 (D-092, D-093). Designed on 2026-11-05 in #99. A spike showed that a
plugin monitor wakes an idle session and that a forged line gets nothing.

Why: an agent today is a second program. Its owner clones WebChat, signs the agent up with an
invite code and a password, adds it to the project, compares a security code, writes
`config.json`, and keeps `npm run agent -- watch` running beside Claude Code (R-027). Students
want one install in the coding agent they already use, and a run they can start from the phone.

How it works:

- The plugin holds an MCP server, a monitor, hooks and a skill. Claude Code starts them with the
  session, so the owner runs only `claude` in the repository and leaves it open.
- The MCP server is the trusted part. It holds the agent's keys and uses the owner's `gh` login.
  It checks in every 15 seconds and checks requests as D-089 says. It claims, pushes `agent/*`
  branches, opens draft pull requests and reports.
- The monitor runs `tail -F` on a file the MCP server writes. Each line reaches Claude as a
  notification. A line holds a run id and a card id, never text a teammate wrote.
- The model calls `start_run` for the card and the decisions, works in a worktree, then calls
  `publish` and `finish`. It holds no credentials.
- PR watching: CI failures, conflicts, and review comments from the owner or the repository's
  writers ring the same doorbell, only for pull requests the plugin opened. A pull request gets
  at most 3 fix attempts. Watching stops when someone else pushes to it, or it is closed, merged
  or marked ready.
- Pairing replaces sign-up. The owner clicks "Connect coding agent" in WebChat, pastes the code
  into the plugin's setup dialog, and approves on the page. The page creates the agent account,
  pins its keys and adds it to the projects the owner picks. The plugin pins the owner's keys.
  No invite code, password or security code.
- While the session is closed or the laptop sleeps, the play button shows the agent as asleep.
  Claude Code on an always-on server keeps it awake.

Security:

- The model never sees a secret: not the agent's keys or login token, the pairing code or the
  `gh` token. The pairing code reaches the MCP server through a sensitive `userConfig` field.
- The model's shell runs in the Claude Code sandbox, with the network open only to the package
  registry and the plugin's data folder unreadable. Plugin hooks keep the file tools inside the
  run's worktree and deny web fetches during a run. A plugin cannot turn the sandbox on, so the
  MCP server refuses runs while it is off.
- Only the MCP server talks to WebChat and GitHub. It pushes only the run's branch, never forces
  a push and never merges.
- The pairing code holds 128 bits, so a server that sees the proof cannot guess it offline. It
  works once and lapses after 10 minutes.
- The plugin logs no decrypted text, since its error output lands in Claude Code's log files.
- One session per machine watches for an agent, under a lock file. A run goes to the session
  whose `origin` matches the request's signed `repo`.
- The plugin ships as one bundled file built from a tagged release, with a pinned `version`.

WebChat changes:

- Pairing routes: create without a sign-in, rate-limited and lapsing in 10 minutes; approve, by
  the owner; collect, by the plugin. An agent signs in with a token whose hash the server keeps,
  and has no password and no key backup. Deleting an account deletes its agents.
- `RunRequest` gains a signed `repo`, added so old requests still verify (rule 2). Reports gain
  kinds for PR watching, and the owner can send a signed cancel.
- The play button names an offline agent "asleep since" the time it last checked in.
- `npm run agent` stays for runs without Claude Code, and pairs the same way.

Done when: typecheck, tests and build pass. A test drives pairing, a run and a CI fix against the
real app with a fake model. A teammate's request, a replayed request and a forged doorbell line
each do nothing. The pairing screen and the asleep label have been tried in a browser (D-037).

Open questions:

- The spike ran in auto mode only. Do other permission modes stop for the plugin's tools? What
  happens to a run when the laptop sleeps, or the session compacts?
- `experimental.monitors` may change shape in Claude Code. Does a pinned plugin version shield
  the owner?
- Does Claude Code's secure storage work on a Linux server without a desktop keyring? A new code
  pasted with `/plugin configure webchat@webchat` pairs again at the next session start.

### R-031: The pairing code carries the WebChat address

Status: In progress on `claude/r031-pairing-address` in #101 (D-093).

Why: the plugin asked each person for their WebChat's address as well as the code. The page that
shows the code already knows the address, and a typed one can be wrong.

Scope: the page shows `<address>#<code>`. The plugin and `npm run agent -- pair` read the address
from it. The plugin's address setting stays, optional, for a bare code from an older page.

Done when: the plugin test pairs with an empty address setting, and the dialog shows the address
with the code in a browser.

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

Status: Idea. Depends on R-001.

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

### R-017: Notes in a chat when people join or are removed

Status: Idea. Found while building R-003 on 2026-11-01.

Any member can add someone to a project or group, and the newcomer reads the whole history (D-026,
D-043). The other members see it only in the member count and the member list. WhatsApp shows
"Alice added Carol" in the chat, and Slack shows "Carol joined #general". A note in the message
list would tell everyone who can read along. The server already knows when each member joined, so
the notes would show it nothing new. They should not count as unread.

### R-027: Run a card with a coding agent

Status: In progress. Step 1 of 5, the headless client in `agent/` with `npm run agent` to sign
up, sign in and watch, is on branch `claude/r027-headless-client` (#85, D-085). Step 2, the run
request and reports inside sealed messages, the "Run with" menu on a card and the run card in
#general, is on branch `claude/r027-run-messages` (#86, D-086), on top of #85. Step 3, the
runner that gives each run a worktree and a brief and starts Claude Code headless in it, is on
branch `claude/r027-claude-adapter` (#87, D-087), on top of #86. Step 4, the busy flag in the
daemon's check-ins and the fingerprint, is on branch `claude/r027-busy-flag` (#88), on top of
#87. Step 5, the Codex and Hermes adapters, is on branch `claude/r027-more-adapters` (#89), on
top of #88. Asked for by the owner on 2026-11-05, with
[multica](https://github.com/multica-ai/multica) as the inspiration.

Why: a team writes an issue or an idea as a card on the board (R-021), then one of them copies it
into a terminal and asks Claude Code, Codex or Hermes to do it. The card does not say who is on
it, the agent's result reaches the chat only when that person pastes it, and the agent never sees
the Decisions column it was built to read. The owner wants a button on a K or R card that hands
it to a teammate's idle agent, and a run that reports back into the channel and ends in a pull
request.

Scope:

- A "Run with" menu on an issue or idea card. It lists the agent runtimes of the project that are
  online and idle, such as "claude-code on hazron-mbp". A runtime that is busy or offline is not
  offered, so a click never queues. (Step 2 offers the online ones; busy comes with step 4.)
- A run card in #general for each run: who asked, which card, which runtime, then claimed,
  progress notes, and done with the branch and the pull request, or failed with the reason. The
  card updates in place, as a message with its reactions does.
- A daemon, `webchat-agent`, that a student runs on the machine that holds the repository. It
  signs in, polls, picks up a run, cuts a `git worktree` on a branch named after the card, writes
  the brief, runs the CLI headless, and reports. One run at a time. The brief holds the card at
  the revision that was clicked, the Decisions column, and the rule to end with a draft pull
  request and never to push main.
- When the pull request opens, the GitHub App posts its card into the channel as it does today
  (D-050), and the daemon sets the card's status line to "In progress on branch …", with the doc
  section lock (D-081).
- Adapters for Claude Code first, then Codex and Hermes. Each one knows how to start the CLI
  without a prompt, read its event stream and resume a session.

How it is built:

- The agent is a member account, not the user's device. Each runtime signs up with the invite code
  as its own account and is invited into projects like a person. So it gets chat keys the way rule
  5 allows, signs what it sends with its own key, has presence, and its messages are labeled as
  the agent's. A daemon that held the user's own keys would read every direct message on that
  laptop, and the agent's words would pass as the user's.
- The daemon is a headless client: `shared/e2ee.ts` on Node's Web Crypto, a Node copy of
  `client/src/api.ts`, and the same `POST /api/sync` check-in every 15 seconds (D-004). No new
  transport, no open connection. Its keys live in a file under `~/.webchat/<name>/` that only
  its owner can read. Node has no non-exportable key store, so this is a new line in the README
  list (D-020).
- A run request is an ordinary message in #general whose sealed content carries a `run` field,
  like `pull` under D-042: the card's id, doc, section and revision, and the runtime's account id.
  The text says the same in words. The daemon answers with messages whose `run` field says
  claimed, progress, done or failed, and the page folds them into one run card. The server
  changes not at all for this: it sees messages. The signature proves which member asked (D-016),
  and the daemon runs only requests from accounts its owner allowed.
- Idle is a presence flag. The check-in already marks who is online for the sync fingerprint
  (D-021). The daemon's check-in adds `busy`, which joins the fingerprint, so the menu shows only
  runtimes seen in the last 45 seconds and not busy. The server learns that an agent account is
  busy, not on what.
- A config file maps each project to a local repository path. A run gets its own worktree, a
  branch such as `agent/k12-bad-push-keys`, and a two-hour idle watchdog that kills the CLI and
  reports a failure.

Constraints:

- Rule 1 holds: the card text, the brief and every report are encrypted and signed in the daemon,
  never on the server. The server cannot write a run message, because it holds no chat key
  (D-015), so every report comes from the daemon.
- The brief is what a teammate wrote, run on the daemon owner's machine with their permissions. By
  default only the owner's own account may dispatch to their runtime; a project opts in for its
  other members. The CLI runs in the worktree with edits allowed and no push to main.
- A request the daemon first sees more than 10 minutes after it was sent fails as missed, so an
  agent that comes online on Monday does not start Friday's run unasked.
- The daemon is Node code in a new `agent/` folder, typechecked with the tooling tsconfig by
  `npm run typecheck`. Its decisions, the agent as a member and the run field, are recorded with
  the numbers reserved at the claim.

Build order, each its own pull request: the headless client, then the run messages and the card
menu, then the Claude Code adapter, then the busy flag, then the other adapters. The headless
client pays off on its own, since the tests could drive the app through it.

Out of scope for now: steering a running agent with a reply to its run card, which Claude Code and
Codex can take through a resumed session; running more than one task on a runtime; a runtime
without a local checkout that clones the project's linked repository (R-016); and runs started on
a schedule or by a mention.

Done when: typecheck, tests and build pass. A test drives a run end to end against the real app
with a fake CLI: a member sends a request, the daemon claims it, runs the command in a worktree,
reports done, and the card's status line names the branch. The menu has been tried in a browser
with two accounts, at desktop width and 375 pixels, in light and dark mode, with the daemon online,
busy and offline.

Open questions:

- Should the run card live in the channel the project links to the repository, when there is one,
  instead of #general? The pull request card lands there.
- Should a runtime belong to the project rather than to a member, so it survives the member
  leaving? A member's runtime loses the project's key when they leave (D-044).

## Known issues

### K-47: The agent runs a replayed request, and signs up over plain HTTP

Status: Fixed in #100, with R-030 (D-093). Found while designing R-030 on 2026-11-05.

A run request is signed with its client id, and the database refuses a repeated one
(`messages_by_client_id`). Only an honest server holds to that. `Runs.handle` in `agent/runs.ts`
remembers no request it ran. So a server can post the same signed request again within its 10
minutes, and once the first run has ended, the daemon runs it again.

`Api` in `agent/api.ts` takes any server address. A sign-up to an `http://` address sends the
login key in the clear.

Fix: keep the client ids of the requests the daemon handled for 10 minutes, and refuse a repeat.
Refuse a server address that is not `https://`, except for `localhost`.

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
example the task board (R-001) and an upgrade path that people who self-host can trust.

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
| K-41: An account from before the agent flag never becomes an agent | #91 |
| R-028: Delete an account (D-088) | #94 |
| K-42: The agent's allow list trusts the username the server sends (D-089) | #95 |
| K-45: Your own agent refuses a card a teammate wrote (D-089) | #95 |
| K-46: A card run hangs with no end when its daemon stops | #96 |
