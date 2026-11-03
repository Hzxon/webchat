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
- When you start an item, set it to "In progress" and name your branch. When it reaches main, set it
  to "Done" with its pull request number, move its whole entry to the Done section at the end, add a
  row to the table there, and record its decisions in `decisions.md`. A fixed known issue moves the
  same way. The sections above Done then hold only what is still open.
- When you drop an item, keep it, set it to "Dropped", and say why.

## Next

### R-001: Task board for projects, like Jira

Status: Next. The owner set it aside on 2026-11-01 so that projects could ship first.

Why: students track who does what by when, and today that lives in other apps.

Scope:

- A board for each project with the columns To do, In progress and Done.
- Tasks with a title, notes, an assignee from the project's members, a due date and a priority.
  Tasks move between the columns.
- A "My tasks" view across all projects, sorted by due date.
- Turning a channel message into a task, with the task filled in from the message.

Constraints:

- Titles and notes are encrypted and signed in the browser, like messages (D-014, D-016).
- Status, assignee, due date and priority may be visible to the server. If they are, list them in
  the README and in D-020.
- Every task change must change the sync fingerprint, or pages will not see it (D-021).
- Schema changes go in migration 8 (D-010).

Done when: typecheck, tests and build pass. Tests prove that the database holds no task text in
plain and that only project members can read or change tasks. The board has been tried in a browser
with two accounts (D-037).

Open questions:

- Which key encrypts tasks: the #general channel's key, or a new key for each project, shared the
  same way as channel keys?
- Should due dates send reminders? That needs R-010.
- Sprints, epics and story points stay out unless students ask for them.

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

## Known issues

### K-21: An urgent message from while every tab was closed does not ring

Found while testing a closed browser on 2026-11-01.

A page alerts only for messages that arrive after it loads (D-049). An urgent message sent while
every tab was closed shows only its URGENT tag in the chat list when the page opens again. If its
push reached the device, the notification stays until it is tapped. Without push, for example with
notifications blocked, nothing ever rings, though D-023 says urgent messages ring until the user
acknowledges them. Decide whether an unread urgent message should ring once when a page opens.

### K-27: An IPv6 loopback address still gets TLS

Found while fixing K-10 in #46 on 2026-11-03.

`connectPostgres` in `server/sql.ts` compares `url.hostname` with `::1`, but the WHATWG URL API
keeps the brackets, so the hostname is `[::1]` and never matches. A `DATABASE_URL` with the IPv6
loopback address gets TLS like a remote host. Compare with `[::1]`, or strip the brackets.

### K-28: The New channel dialog overflows at 375 pixels with a long name

Found in the browser check of K-11 in #51 on 2026-11-03.

The preview "It will be called #…" in `client/src/components/ProjectDialogs.tsx` cannot wrap a
name of 39 characters without a space. At 375 pixels the dialog content grows past the dialog,
the close button is half cut off, the preview is clipped and the dialog scrolls sideways. Creating
the channel still works. `overflow-wrap: anywhere` on the preview would fix it.

### K-29: "Turn on notifications" shows on iOS before 16.4

Found in the browser check of K-23 in #48 on 2026-11-03.

The bell dialog in `client/src/components/NotificationDialog.tsx` hides its main button only when
the permission is `denied`. On iOS before 16.4 there is no `Notification`, `enableNotifications` in
`client/src/push.ts` returns early, and the button does nothing. Hide it when `oldIos` is set, or
when push is not supported, and leave the Bark section.

### K-30: A session found expired at load leaves the keys on the device

Found while fixing K-18 in #47 on 2026-11-03.

When the first `GET /api/bootstrap` answers 401, the catch in `client/src/App.tsx` shows the
sign-in screen but does not call `keyring.forget()`, which the check-in 401 path in
`client/src/chat.ts` does. Sessions last 30 days and mostly expire while every tab is closed, so
this is the usual path. The account's keys then stay in IndexedDB for whoever uses the browser next.

### K-31: `sameIds` checks only its first list for duplicates

Found while fixing K-13 in #50 on 2026-11-03.

`sameIds` in `server/db.ts` rejects a first list with repeated ids but not a second one, and it is
called with the wrapped-key list second. A key request with two copies for the same member passes
the check and reaches the insert. Not yet checked what the database does with the duplicate.

### K-32: A send that never ends blocks a chat's later sends

Found while fixing K-24 in #53 on 2026-11-03. Listed as a cost in D-075.

`client/src/api.ts` sets no timeout on `fetch`. Since #53 a chat's sends wait for each other, so a
request that never answers, for example on a connection that drops without a reset, holds every
later send in that chat until a reload. Give requests a timeout with `AbortController`, and let a
timed-out send fail like any other so the queue moves on.

### K-33: The service worker never removes a replaced push endpoint

Found while fixing K-17 in #49 on 2026-11-03.

The `pushsubscriptionchange` handler in `client/src/sw.ts` subscribes again but ignores the event's
`oldSubscription`. The old row stays on the server until the push service rejects it with 404 or
410, and every push until then is sent twice, once to a dead endpoint. Tell the server to delete
the old endpoint when the event carries one.

### K-34: `shared/types.ts` says it holds only types

Found while fixing K-11 in #51 on 2026-11-03.

The header of `shared/types.ts` says only type declarations live there, but the file also holds
`BUILD_HEADER`, `showsEveryPush` and, since #51, `isChannelName` and `toChannelName`. Fix the
header, or move the functions to a file of their own and add it to the map in AGENTS.md.

### K-35: The map of the code does not list `client/src/queue.ts`

Found while fixing K-24 in #53 on 2026-11-03.

#53 adds `client/src/queue.ts`, the per-chat send queue of D-075, and the map in AGENTS.md does not
name it. Add a row once #53 is on main.
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

Finished work. The table is the index; the entries below it keep their numbers, reasons and pull
requests for the record. Nothing here is a candidate for what to do next.

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

### K-24: Quick sends can be stored out of order

Status: Fixed in #53 (D-075). A test runs jobs through the per-chat queue in
`client/src/queue.ts`; the page's own sends have not been tried in a browser yet.

Found while testing #21.

`sendContent` in `client/src/chat.ts` encrypts and posts each message on its own, and the server
numbers messages in the order they arrive. Sending "one" to "five" with Enter in quick succession
stored them as one, three, four, two, five, and a reload showed the same order. Send a chat's
messages one at a time, in the order they were written.

### K-14: Sign-ins from one address share a small rate limit

Status: Fixed in #52 (D-068). Integration tests sign in 21 times from one address without a
lockout, and check that 20 wrong passwords still lock it out, even for the right password.

Register, login, upgrade and key routes shared 20 requests per 15 minutes per IP address, and
successes counted. A class that signed up together behind one campus address locked itself out
for 15 minutes. Now each attempt still counts before it runs, and a success gives its hit back, so
only failures use up the limit. Not seen on a real deployment.

### K-11: The New channel dialog can make names the server refuses

Status: Fixed in #51 (D-065). Tests cover a long name with a hyphen at the cut, ℂ, and a
character cut in half, and the server accepts each name the rule makes.

`toChannelName` in `client/src/components/ProjectDialogs.tsx` trimmed hyphens before it cut the name
to 40 characters and kept capitals with no lowercase form, such as ℂ. The server then answered 400.
Now one rule in `shared/types.ts` makes the names on the page and checks them on the server.

### K-13: The first key of a group from before encryption races with a removal

Status: Fixed in #50. An integration test removes a member right after the route has read the
members, and checks that the key is refused and the person removed holds no copy and owns nothing.

`POST /conversations/:id/key` reads the members without the group's lock. A removal at the same
moment can leave a copy for the person removed, or make the removed person the owner of a group
nobody can then open. It needs a group from before encryption with no key yet. Now the route checks
the members again under the group's lock, in the transaction that stores the key, and answers
`409 stale_group` when they changed. The page reloads and tries once more.

### K-17: An open page kept a push endpoint the service worker replaced

Status: Fixed in #49. A node test runs the worker's `pushsubscriptionchange` handler with a fake
global scope and checks that every open page is told. The page's side has not been tried in Firefox
yet.

The service worker's `pushsubscriptionchange` handler subscribed again but did not tell open pages.
They kept reporting the old endpoint, so pushes for the user while they looked went to a dead
endpoint, and messages showed up to 15 seconds late until a reload. Mostly Firefox fires this
event. Now the worker posts `subscription-changed` to every open page, which saves the new
subscription, reads its endpoint and checks in at once, as at start.

### K-23: The Home Screen banner promises notifications on iOS before 16.4

Status: Fixed in #48. A node test reads the version from real user agents of iOS 15.8, 16.3,
16.4 and 17, an iPad, Chrome on iOS and desktop browsers. An iPad that asks for desktop sites
reports itself as a Mac with no iOS version, so it still gets the Home Screen advice.

Found while fixing the phone layout in #20. Seen on iOS 15.8 in #21.

Web Push reached Home Screen apps in iOS 16.4. On iOS 15.4 to 16.3, the banner in
`client/src/components/Sidebar.tsx` still says to add the site to the Home Screen to get
notifications, which never works there. In the Home Screen app it says "Turn on notifications",
though that iOS has no `Notification` at all. `needsInstall` in `client/src/push.ts` checks only for
iPhone or iPad. Read the iOS version from the user agent, and before 16.4 say that notifications
need iOS 16.4.

### K-18: A session that expires leaves push on for that browser

Status: Fixed in #47 (D-072). An integration test checks that the server deletes a subscription
the push service answers 410 Gone. The page's side runs in the browser, which no test reaches, and
is still to be tried by hand.

When a session ends with a 401, the page drops the keys but not the push subscription. Whoever uses
that browser next sees the old account's notification titles, such as sender and chat names, until
the subscription is removed. Only "Sign out" removes it.

### K-10: `sslmode=disable` is ignored

Status: Fixed in #46. `sslmode=disable` in `DATABASE_URL` now turns TLS off for any host. Without
it, a host that is not loopback still gets TLS. A test checks the options the pool gets; no Postgres
without TLS was tried. `.env.example` names the option.

`connectPostgres` in `server/sql.ts` turns TLS on for every host except three loopback names and
deletes `sslmode`. A self-hosted Postgres without TLS on another host, such as `db` in Docker
Compose, cannot be reached, and the server stops at start. Only an undocumented `?ssl=0` works.

### K-16: A reaction push can replace a message notification

Status: Fixed in #45 (D-070). An integration test checks that a reaction's push goes only to the
browser in use, has the kind the service worker shows nothing for, and has a tag other than the
chat's message tag. No test runs the service worker, and it was not tried on a real device.

A reaction push uses the chat's notification tag. When the server still thinks the user is looking,
for example after a laptop slept before its check-in went out, the service worker shows "Bob reacted
to a message" over the chat's message notification. D-030 says reactions notify nobody. Not seen on
a real device.

### K-15: A late sync answer can close a chat just created

Status: Fixed in #44 (D-069). Tests in `test/store.test.ts` cover the store's side. No automated
test drives the sync loop in `client/src/chat.ts`, and the browser check is still to do.

`applySync` drops every chat missing from an answer. An answer built before a new chat committed,
but applied after it opened, closed the chat with "It was deleted, or you were removed." The next
check-in brought it back. Now the page counts its own changes to chats and projects, and drops an
answer requested before the latest one.

### K-12: A push subscription with malformed keys breaks pushes for its owner

Status: Fixed in #43. Integration tests subscribe with keys of the wrong size and get a 400, and
show that a subscription web-push cannot encrypt for is deleted while the next push still goes out.

`generateRequestDetails` in `server/push.ts` threw before the `try` for keys of the wrong size, so
the row was never deleted. Every later push to that user failed, `/api/push/test` answered 500, and
a GitHub poll stopped after its first alert with a false "Could not reach GitHub". It needed a
hand-made subscription. Now subscribing checks that the p256dh key is 65 bytes and the auth secret
16, and a subscription web-push throws on is deleted. A network error still keeps the row.

### K-26: Messages from changed keys stayed unreadable after the check until a reload

Status: Fixed in #42. Keyring tests check that nothing held back opens before the check, and that
the held message and reaction both open after it. Not yet tried in a browser.

Found in a security review of main on 2026-11-03.

Until the user checks a changed security code, the page shows that person's new messages as
unreadable (D-018). Checking the code in `trustKeys` in `client/src/chat.ts` updated the warnings,
but the messages already loaded kept their failed state, and failed reactions were dropped. A
reload decrypted them. Now the keyring keeps every message and reaction that failed to open, and
`trustKeys` opens them again through the same decrypt path and puts those that open in the chat.

### K-19: The push test for plain text cannot fail

Status: Fixed in #41. The new check was shown to fail with the message, and with only "me back",
put into the push payload on the server, where the old check passed.

The test "pushes carry no plain text" in `test/chat.test.ts` looks for `urgent, `, which the message
`Call me back, it is urgent` does not contain. Only its separate check of `payload.body` guards rule
7. Now the test searches the whole payload for the message and for its words "Call" and "back".
"urgent" is left out, because the payload's field name and tag carry it.

### K-6: Organizations that restrict OAuth Apps hide their pull requests without a hint

Status: Fixed in #34 (D-060). Tested against GitHub's answer as community reports describe it: a
200 with the pull requests of the organization left out and one FORBIDDEN error for each, naming
the organization. Not yet seen on a real organization; the first report from one should confirm
the wording the server matches.

Course repositories usually live in an instructor's organization, such as a GitHub Classroom one.
An organization that restricts OAuth Apps hides its pull requests until an owner approves WebChat
(D-033), and a student cannot fix that alone. The README said so in one line; the connect card and
the pane said nothing. GitHub's GraphQL answer carries the error next to the data (`graphql` in
`server/github.ts` dropped it). The pane now names the organization and links to how a member
asks for approval, and the connect card says an organization may need to approve the app.

### K-9: Retrying a send can store the message twice

Status: Fixed in #35 (D-061). An integration test sends the same client id twice and checks that
one row is stored, the second answer carries the first message, and the push goes out once.

`retryMessage` sent with a new client id, and the server did not check client ids. When a send
committed but its answer was lost, a retry stored a second copy, and an urgent one alerted twice.
Now the retry keeps the client id, and (chat, sender, client id) is unique.

### K-5: The connect card promised alerts with every tab closed

Status: Fixed in #29 (D-057). On 2026-11-02, a dry run on the production database ran the setup
through the pooler as WebChat's role: it enabled pg_cron 1.6.4 and pg_net 0.20.4, scheduled the
job, and queued its request, then rolled back. The job first runs after the merge, which deploys
it.

The connect card in `client/src/components/GithubView.tsx` said WebChat alerts "even with this tab
closed". On Vercel Hobby that held only after the owner set `CRON_SECRET` and a scheduler called
`GET /api/github/poll` (D-034). Production had neither, so nothing polled while every tab was
closed, and nobody was told.

### K-8: The ciphertext length shows the message length and some reactions

Status: Fixed in #33 (D-059). A crypto test checks that a ❤️ reaction, a 👍 reaction, a take-back
and two short messages all give a ciphertext of 272 bytes, and that an envelope made without
padding still opens. Found in a review of main on 2026-11-01, with K-7 and K-9 to K-19.

Envelopes are not padded, so the server sees the exact length of every message. For the same
message, a ❤️ reaction is longer than the other five quick reactions, and taking a reaction back is
shorter. The README says the server cannot see which emoji. Pad envelopes to a few fixed sizes, or
correct the README and D-020.

### K-7: A sync answer whose body breaks off sets the cursor to NaN

Status: Fixed in #27 (D-056). Reproduced in Chromium on 2026-11-02 by cutting one sync answer in
half: the check-ins after it sent `cursor: null` before the fix, and the real cursor after it.
Found in a review of main on 2026-11-01, with K-8 to K-19.

`request` in `client/src/api.ts` turns a 2xx response whose body fails to parse into `{}` and
returns it as success. `syncNow` then sets the cursor to NaN, which stays NaN, and every check-in
asks from 0. A user with more than 500 messages then stops getting new ones until a reload. Treat a
body that fails to parse on a 2xx as an error.

### K-25: The page slid as the iPhone keyboard opened

Status: Fixed in #22 (D-053). Seen by the owner on iOS 15.8 after #21, in a screen recording. The
fix was checked in Chromium, not yet on an iPhone.

Opening a chat focused the message box, and the keyboard came up. Safari animated its scroll to
lift the box, and the reset from #21 ran midway through. The page dropped by about a keyboard's
height, showed a band of the status bar colour, and slid back up as the keyboard rose.

### K-22: The keyboard on iPhone pushed the chat header off screen

Status: Fixed in #21 (D-053). Suspected in #20, and seen on iOS 15.8 by the owner. The fix was
checked in Chromium with a simulated keyboard, not yet on an iPhone.

Safari on iPhone does not shrink the page when the keyboard opens. It scrolls the page up until the
focused field shows, so the chat header left the screen while you typed, and a dialog's lower
fields could sit behind the keyboard.

### K-20: Closing the tab lost drafts and messages not sent

Status: Fixed in #19 (D-051). Found while testing a closed browser on 2026-11-01, with K-21.

A draft lived only in the message box, and a message still sending or not sent lived only in the
page. Closing or reloading the tab, or opening another chat, dropped them without a warning. The
person they were for never got them.

### R-002: Rotate keys on removal, and let people leave

Status: Done in #13 (D-044, D-045). Owners could remove people since #4, without rotation (D-039).

Why: people removed from a project or group keep its keys (D-039). Nobody can leave on their own,
and an owner cannot hand a project or group to someone else.

Scope:

- On removal, every chat in the project or group gets a new key, wrapped for the people who stay.
  Pages keep the old keys to read old messages, so a chat can have more than one key id. The signed
  header already names the key id (D-016).
- Leaving. A page accepts a copy of a key only from a current member (D-015), and a person who
  leaves cannot wrap copies for the others. Someone who stays has to make new copies, so leaving may
  wait for another member's browser.
- Handing a project or group to another member, so that its owner can leave too.

Done when: a removed member cannot decrypt anything sent after the removal, and a test proves it.
Members can leave, and an owner can hand over.

Answered: someone who joins after a rotation reads the whole history. Each new key holds the one it
replaced, so the current key opens every earlier one (D-044).

### R-013: Share a pull request into a channel

Status: Done in #8 (D-042). The "later" part came in #14 (D-046): the author's browser posts the
card by itself into the channel of each project that links the repository. #17 replaced that with
cards the server writes from the GitHub App's webhooks (D-050). The card is a field
inside an ordinary message rather than a kind of its own, because it should count as unread,
preview and push exactly like a message. Found in a review of the GitHub connector on 2026-11-01.

Why: the pull requests pane is personal (D-033). Nothing about a pull request reaches a project
channel, so a team learns that one was opened or merged only when its author types it. The
discussion and the pull request stay in different apps, which is what WebChat set out to fix.

Scope:

- A "Share" button on a pull request in the pane sends a message to a chosen chat or channel.
- The message is a new signed kind, like reactions (D-016, D-030). It carries the repository, the
  number, the title, the URL and the status at that moment: checks, review decision, conflicts,
  draft, merged or closed.
- The page renders it as a card with the status tags of the pane, and a click opens GitHub.
- Later: the author's browser can post a card by itself to a channel they pick when one of their
  own pull requests opens or is merged. The server sees nothing new, because the browser encrypts
  the card like any message.

Done when: a card sent from the pane shows in the channel for every member, with the server holding
only ciphertext, and a test proves it.

### K-4: A group's member names change order

Status: Fixed in #6. The members query orders by join time, which also confirmed the cause.

A group's header lists its members in the order the server returns them, and that order changed
during testing on 2026-11-01: "You, Bob, Carol" became "Bob, You" after a removal and new messages.
The likely cause, not yet confirmed: the members query in `conversations()` in `server/db.ts` has no
`ORDER BY`, so Postgres returns the rows in storage order, which an update changes. Ordering the
members, for example by when they joined, would keep the names still.

### K-3: The README and package.json disagree about Node

Status: Fixed in #6. Local development runs on Node 26, as `engines` pins (D-013).

The README asks for Node 22.13 or later to run WebChat locally. The `engines` field in
`package.json` pins Node 26.x (D-013). Decide which versions local development supports, and make
both say the same.

### K-2: Dialogs open with the focus on the close button

Status: Fixed in #6. The cause was close: React calls `focus()` on the field while the dialog is
still closed, so nothing happens, and `showModal()` then focuses the close button. `Dialog` now
focuses the first field in its body after `showModal()`.

Fields marked `autoFocus` inside a dialog do not get the focus, so typing goes nowhere until the
user clicks the field. This was seen in the New channel dialog on 2026-11-01. The likely cause, not
yet confirmed: `Dialog` in `client/src/components/Dialog.tsx` calls `showModal()` after React has
focused the field, and `showModal()` moves the focus to the dialog's first focusable element, its
close button.

### K-1: Old tabs show reactions as messages they cannot decrypt

Status: Fixed in #6 (D-040).

A tab that still runs the app from before #2 shows each reaction as "could not be decrypted" until
it reloads. A version check that reloads tabs after a deploy would fix this one and future format
changes.

### R-018: Alerts on iPhones without Web Push, through the Bark app

Status: Done in #23 (D-054).

Why: an iPhone on iOS 15, such as an iPhone 7 Plus, can never get Web Push, which Apple added in
iOS 16.4, and a native app would need the paid Apple Developer Program for its push. Students keep
such phones, and WebChat on them alerts only while the page is open.

Scope: WebChat acts as a Bark server for one person at a time. Bark is a free, open-source
notification app whose author publishes the APNs key the app's pushes are signed with. The person
installs Bark, gives it a server URL from the bell dialog, and from then on the server sends an
APNs push to that phone whenever a Web Push would go to their other devices: chat and sender name,
never the message text. Optional encryption with a key typed into Bark hides even those names from
Apple. Done when a phone on iOS 15.8 shows a banner within seconds of a message, with the tests and
the README setup. The tests run against a fake Apple push service. Checked by the owner on an
iPhone 7 Plus on iOS 15.8.8 on 2026-11-02 against a local server with Bark's key: the test banner,
a normal and an urgent alert, and an encrypted one that Bark read on the phone. The first alert
from the production deployment reached the same phone the same day, which confirmed that a Vercel
function can open HTTP/2 to Apple.
