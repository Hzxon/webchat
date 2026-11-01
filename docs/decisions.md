# Decisions

This is the log of the decisions that shape WebChat. Each entry says what was decided, why, and what
it costs. Read the entries for the area you work on before you change how something works. Start at
[AGENTS.md](../AGENTS.md) if you have not read it yet.

## How to add or change an entry

- Add a decision in the same pull request as the change that makes it.
- Take the next free number. Numbers never change and are never reused.
- Say the decision first, then why it was made, then what it costs. Name the commit or pull request.
- Never delete an entry. When a decision replaces an older one, change the old entry's status line
  to "Superseded by D-0xx" and say in the new entry what it replaces.
- An entry is Accepted once the change that makes it is on main. A decision agreed but not built yet
  is Proposed.

Commits are short hashes on main. Pull requests are numbered, as in #2.

## Product and scope

### D-001: Audience and product direction

Accepted 2026-11-01.

WebChat began as a chat for friends whose urgent WhatsApp messages reached them late (74d53ff). On
2026-11-01 the owner named its main users: college students who run several group projects at once.
The product grows toward three tools they already know, in one place: chat like WhatsApp, projects
and channels like Slack, and task tracking like Jira. Chat came first, then projects with replies
and reactions (#2). The owner set the task board aside for later; it is roadmap item R-001.

Cost: judge each new feature by whether it helps a student team plan and finish its projects.

### D-002: One invite-only community per deployment

Accepted 2026-11-01 in 74d53ff.

Sign-up needs the deployment's invite code. The owner sets it with `INVITE_CODE`. Without it, the
server generates one on first start, and a self-hosted server prints it in its log. Vercel does not
print it, so set `INVITE_CODE` there. Everyone on a deployment can see everyone else's name and
online status, and can start a chat with them.

Cost: there is no privacy between the people on one deployment, and one deployment cannot host
separate communities. A class, a club or a group of friends each runs its own deployment.

### D-003: Free hosting first

Accepted 2026-11-01 in 74d53ff.

WebChat must run at no cost: Vercel's Hobby plan for the app and Supabase's free Postgres for the
data. The function runs in Singapore (`sin1` in `vercel.json`), in the same region as the database.
A self-hosted Node process with PGlite or any Postgres is the alternative.

Cost: Vercel Hobby is for personal, non-commercial use. Supabase pauses a free project after about a
week without activity. Hobby cron jobs run only once a day (D-034). The free plan's limits are the
reason for D-004.

## Architecture and hosting

### D-004: No open connections: check-ins and Web Push

Accepted 2026-11-01 in 74d53ff.

The server runs as short-lived functions. On Vercel's free plan, every open connection would use up
the monthly allowance in about a week. So pages check in with `POST /api/sync`, which answers
"unchanged" from one cheap query while nothing has changed (D-021). Web Push is the fast path: it
shows the notification and makes open tabs check in at once. Tabs check in every 3 seconds while the
user looks at them with push off, every 15 seconds with push on, and less often in the background.

Cost: without push, a new message can take up to 3 seconds to show while the user looks, and longer
in the background. Typing indicators and instant presence do not fit this model. Vercel Functions
can now hold WebSockets; whether that fits the free plan is open question Q-1 in the roadmap.

### D-005: One Express app for Vercel and for self-hosting

Accepted 2026-11-01 in 74d53ff.

`api/index.ts` wraps the Express app as a single Vercel function, and `vercel.json` sends every
`/api/*` request to it. `npm start` runs the same app in one Node process, which also serves the
built client. Work that can finish after the response, such as sending pushes, runs through
`waitUntil`, so the function stays alive until it is done.

Cost: one function serves every route, so every route shares its 30-second `maxDuration`.

### D-006: Postgres in its own schema, PGlite for development and tests

Accepted 2026-11-01 in 74d53ff.

All tables live in the `webchat` schema. Supabase's generated REST API exposes only the `public`
schema, so these tables are reachable only through this server. Without `DATABASE_URL` or
`POSTGRES_URL`, the server uses PGlite, an embedded Postgres, in `data/pglite`. Tests use it in
memory. `server/sql.ts` imports PGlite through a computed module name, so Vercel's bundler leaves
its 26 MB out of the function.

Cost: every query must run on both PGlite and Postgres. PGlite takes one statement per query, so
schema and migrations are split into statements before they run.

### D-007: Pushes follow the user's attention

Accepted 2026-11-01 in 74d53ff.

Every check-in says whether the user is looking at that tab: visible, focused, and used in the last
2 minutes. While they are, a new message is pushed only to that browser, so their phone stays quiet
at the desk. Otherwise every device with notifications on gets it. A tab that is looked at but has
no push subscription gets no push at all; it checks in every 3 seconds instead. A closing tab sends
a beacon to `POST /api/away`, which ends its attention at once.

Cost: attention lasts 45 seconds after the last check-in. A tab that dies without sending its
beacon can keep pushes away from the phone for up to that long.

### D-008: Each tab acts only as the account it shows

Accepted 2026-11-01 in b75d690.

All tabs of a browser share one session cookie. Every API request names the account its tab shows,
in the `x-webchat-user` header. The server refuses a mismatch with `409 account_changed`, and the
tab reloads. Signing in or out also reloads the other tabs through a BroadcastChannel. Without this,
a tab could keep showing one account while the server acted as another, and store a message under
the wrong sender.

Cost: a tab reloads without warning when another tab switches accounts.

### D-009: Strict security headers

Accepted 2026-11-01 in 74d53ff.

The Content Security Policy lets the page load scripts, styles, workers and the manifest, and
connect, only to its own site. Images may also be data URLs, and no other site may frame the page.
Responses also send `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. The
service worker is served with `Cache-Control: no-cache`, so updates reach every device. Vercel sends
these headers from `vercel.json`, and a self-hosted server sends the same ones from `server/app.ts`.

Cost: third-party scripts, fonts, analytics or CDNs need a change to the policy. Change
`vercel.json` and `server/app.ts` together.

### D-040: Open tabs reload when the build changes

Accepted 2026-11-01 in #6.

Every `/api` response carries an `X-WebChat-Build` header that names the running build. The page
remembers the first value it sees and reloads when a later response carries another, as soon as
nobody is typing in it. On Vercel the name is the deployment id. Elsewhere it is `WEBCHAT_BUILD`,
or a hash of the built `index.html`, whose script tags change with every client build. Without a
built page, as in tests and in development, no header is sent and tabs never reload.

Why: a tab from before a deploy keeps its old code until it reloads. Old tabs showed each reaction
as a message they could not decrypt after #2 (K-1), and every later format change would do the
same. A check-in is the only channel to a tab (D-004), so the header rides on it.

Cost: a deploy reloads every open tab once, which drops scroll positions. A self-hosted server that
restarts with the same build does not reload tabs, because the hash comes from the page, not from
the start time.

### D-041: Only main deploys from Git

Accepted 2026-11-01 in #7.

`git.deploymentEnabled` in `vercel.json` turns off automatic deployments for every branch but
`main`. Vercel for GitHub otherwise built a preview for every push and a production deployment for
every merge, two builds per pull request, from Hobby build minutes and the daily deployment cap.

Why: a preview of this app is not useful. The GitHub connector cannot connect on a preview URL,
because the OAuth App has one callback URL (D-032). The server runs pending migrations at start
(D-010), so a preview that shares the production database would apply a branch's new migration
before the pull request merges. Changes people see are checked locally instead (D-037).

Cost: no preview URL on pull requests. Trying a branch on a real phone, where push needs HTTPS,
takes a deployment by hand with `vercel deploy`, which the setting does not stop.

## Data and platform

### D-010: Migrations only grow at the end

Accepted 2026-11-01 in 10ba6d8. The rule about numbers comes from #2.

`SCHEMA` in `server/db.ts` creates the original tables. Every later change is an entry at the end of
`MIGRATIONS`. Each entry runs once, in order, in a transaction that holds an advisory lock, because
several serverless instances can start at once. `webchat.meta` records how many have run. So far:
1 is end-to-end encryption, 2 is the GitHub connector, 3 is projects with replies and reactions, and
4 is group owners (#4).

Two branches once both added a migration 2. The projects migration became 3 when its branch merged,
because a database that had already run the connector's migration 2 would have skipped it. When two
branches add migrations, the one that reaches main first keeps its number.

Cost: a mistake in a migration on main is fixed with a new migration, never by editing the old one.

### D-011: Limits live in one place

Accepted 2026-11-01 in 74d53ff, extended in 10ba6d8, #2 and #4.

`LIMITS` in `shared/types.ts` holds the sizes that the server enforces and the page respects: 4,000
characters per message, 160 per quote, 24,000 per ciphertext, the lengths of names, 50 messages per
history page, and 20 people added to a project at once. Express accepts JSON bodies of up to 64 KB
(`server/app.ts`), raised from 16 KB for encryption in 10ba6d8. That caps batch requests: adding 20
people to a project sends every channel's key wrapped for each of them. Removing someone sends every
channel's key wrapped again for each person who stays (D-039). A copy takes about 110 bytes, so a
project nears the cap at about 20 people with 30 channels.

Cost: raising a limit can need a larger body limit too. Check both.

### D-012: Query strings through the WHATWG URL API

Accepted 2026-11-01 in d4083df.

Reading `req.query` makes Express call Node's `url.parse()`, and Vercel then logs its deprecation
warning (DEP0169). Routes read query strings with the WHATWG URL API instead. The history route does
it inline, and the GitHub routes use the `queryOf` helper in `server/api.ts`, added in #1.

### D-013: Node and build pinned for Vercel

Accepted 2026-11-01 in 8865bd3.

The `engines` field pins Node 26.x, so a new major Node release cannot change the function's runtime
by surprise. `tsconfig.json` spells out `typeRoots`, because Vercel compiles `api/index.ts` from a
temporary tsconfig in another folder that extends this one. `allowScripts` in `package.json` denies
the install scripts of esbuild and fsevents, which nothing needs.

Cost: moving to a new major Node release is a deliberate change to `engines`, and the README's
requirement moves with it. Local development runs on the same Node 26 as Vercel (K-3).

## End-to-end encryption

### D-014: End-to-end encryption in the browser

Accepted 2026-11-01 in 10ba6d8.

All end-to-end encryption is in `shared/e2ee.ts` and uses only Web Crypto, so it runs in the page,
the service worker and the tests. The password never leaves the browser. PBKDF2 with 600,000 rounds
and HKDF turn it into a login key, which the server stores only as a scrypt hash, and a separate
backup key. Each account has a P-256 ECDH pair, which receives chat keys, and an ECDSA pair, which
signs messages. The server keeps the private keys only sealed with the backup key, so signing in on
any device unlocks the full history. Each device keeps them in IndexedDB as non-exportable keys.

Cost: a forgotten password loses the encrypted history, and there is no reset. D-020 lists what the
server can still see.

### D-015: One key per chat, wrapped for each member

Accepted 2026-11-01 in 10ba6d8, extended in #4.

Each chat has a random AES-256-GCM key. The member who creates it wraps a copy for every member with
a key from ECDH between the two of them, so a wrapped copy proves who made it. The page accepts a
copy only when the person who wrapped it is a member of the chat. The server checks that a new key
comes wrapped exactly once for every member. When someone is removed, the person removing them wraps
every copy again, so each copy left was made by a current member (D-039).

Cost: a chat keeps one key for its lifetime, so people removed from it keep that key (D-039, roadmap
R-002).

### D-016: Encrypt, then sign everything the server could change

Accepted 2026-11-01 in 10ba6d8. The kind joined the signed header in #2.

A message is encrypted with the chat key, then signed with the sender's ECDSA key. The signature
covers the ciphertext and a header with the chat, the key id, the sender, the urgent flag, the
client id, and the kind for kinds other than "message". The page rejects a message whose header the
server changed and shows it as "could not be decrypted".

The kind is in the header only for new kinds, so messages signed before kinds existed still verify.
A new field that the server stores and the page acts on must join the header the same way.

Cost: the server cannot correct a signed field. It must refuse a bad value instead of changing it.
For example, it refuses an urgent reaction rather than clearing the urgent flag.

### D-017: Notifications decrypt on the device

Accepted 2026-11-01 in 10ba6d8.

A push for a message carries the encrypted envelope when the whole payload fits in 3,000 bytes,
which leaves room under the push services' limit of about 4 KB. The service worker decrypts it with
the keys the page left in IndexedDB, and the notification shows the text. A message too long for a
push shows "New message". When the device lacks the keys or the signature check fails, it shows "New
encrypted message".

Cost: the service worker needs the chat keys and everyone's public keys in IndexedDB. A push never
carries the plain text of an encrypted message.

### D-018: Trust on first use, checked with security codes

Accepted 2026-11-01 in 10ba6d8.

Each device remembers the keys it first saw for each person and warns when they change. Until the
user checks them, the page refuses to wrap a new chat key for that person. Two people can compare a
60-digit security code: matching codes mean nobody swapped keys between them.

Cost: a device trusts the first keys it sees for a person without proof.

### D-019: Accounts and chats from before encryption upgrade once

Accepted 2026-11-01 in 10ba6d8.

An account created before encryption has `auth_version` 1. Its owner signs in once with the
password, which the server checks against the old hash before storing the hash of the new login
key. That request is the only one that ever carries a password. Old messages stay readable and show
"Not encrypted". A chat from before encryption gets its key from the first member who sends a
message, and the first key set wins.

### D-020: Known limits of the encryption

Accepted 2026-11-01 in 10ba6d8, extended in #1, #2, #4 and #14.

WebChat accepts these limits and lists them in the README:

- The page runs the code the server sends, so an operator who changes the app could read messages.
- Metadata stays visible to the server: who talks to whom and when, group, project and channel
  names, who is in which project and who added them, who made each project and group, display
  names, whether a message is urgent, and that someone reacted.
- Pull request titles and repository names are not end-to-end encrypted (D-033).
- Which repositories a project links, and which pull requests were shared into which channel on
  their own (D-046).
- The member list that a new channel's key is wrapped for comes from the server. The New channel
  dialog shows it so people can check it.
- People removed from a project or group keep the keys they had (D-039).

Cost: a feature that shows the server something new must add it to this list and to the README.

## Messaging

### D-021: The sync fingerprint is the change detector

Accepted 2026-11-01 in 74d53ff, extended in #2 and #4.

`db.stamp` builds one string per user from a single query. It covers the sum of the newest event
ids in their chats, the read and delivered pointers, how many chats they are in, the sum of the
times their members joined those chats, how many chats have keys, how many people there are and how
many have keys, and who is online. A check-in whose stamp matches answers "unchanged" without
loading anything else.

Cost: any state that pages must see has to change this string, or pages miss it until something
else changes. #2 added the newest event ids, so reactions show up, and the member count, so new
members show up. #4 replaced the member count with the sum of join times, so one person leaving and
another joining between two check-ins still show up.

### D-022: Receipts are per-member pointers

Accepted 2026-11-01 in 74d53ff.

Each member of a chat has a delivered pointer and a read pointer. Messages with an id at or below a
pointer count as delivered or read. Check-ins move the delivered pointer, and opening a chat moves
the read pointer. The service worker reports delivery when a push arrives, so the sender sees
"delivered" even while every tab of the recipient is closed.

### D-023: Urgent messages ring until acknowledged

Accepted 2026-11-01 in 74d53ff.

The sender marks a message urgent with the bell next to the message box, and the urgent flag is
signed (D-016). The recipient's open tab shows a full-screen alert and rings until they dismiss it,
even with message sounds off. The push waits up to 3 days for an offline device instead of 1, and
the notification stays until the user acts on it. Reactions cannot be urgent (D-016, D-030).

## Projects and channels

### D-024: Every project member is in every channel

Accepted 2026-11-01 in #2.

A project is a team, and its channels are chats of type `channel` that belong to it. Every project
member is a member of every channel. One rule then decides who holds each channel key, and student
teams are small enough not to need private channels yet.

Cost: there are no private channels. They need a different design for membership and keys (roadmap
R-004).

### D-025: Channel keys go to exactly the current members

Accepted 2026-11-01 in #2.

A new channel and a new member can race. Both changes lock the project's row and check under the
lock. A new channel's key must be wrapped for exactly the people in the project at that moment.
Adding people must bring the current key of every channel, wrapped for each of them. Otherwise the
server answers `409 stale_project`, and the page reloads its data and tries once more.

Cost: under contention, a change can fail once and retry. A second conflict reaches the user as an
error.

### D-026: New members read the history

Accepted 2026-11-01 in #2.

When a member adds someone, that member's browser opens its own copy of each channel key and wraps
it for the newcomer. Keys never rotate, so the newcomer can read every earlier message, as when
joining a Slack channel. Their read pointers start at the newest message, so the history does not
count as unread. Being added sends a notification (D-031).

Cost: only a member whose browser can open every channel key can add people. The server records who
added whom.

### D-027: Slack-style channel names

Accepted 2026-11-01 in #2.

Channel names use lowercase letters and digits in any script, joined by single hyphens, up to 40
characters, and are unique within their project. The page turns what people type into that form,
so "Slides & Design" becomes `slides-design`. Every project starts with `#general`.

### D-028: No leaving or removal before key rotation

Superseded by D-039. Accepted 2026-11-01 in #2.

Nobody can leave a project or be removed from one yet. A removed member would still hold every
channel key, so removal without key rotation would only stop the server from sending them new
messages. Groups also cannot take new members after they are created; projects can.

Cost: a mistaken add cannot be undone in the app (roadmap R-002), and a teammate who joins late
needs a new group (roadmap R-003).

### D-039: Owners remove people and delete, before key rotation

Accepted 2026-11-01 in #4. Replaces D-028.

The person who made a project or group is its owner. Only the owner can remove people from it, or
delete it for everyone with every channel and message. Projects already recorded who made them.
Migration 4 adds `conversations.created_by` for groups. Every copy of a group's key was wrapped by
the person who made it, so existing groups get that person. A group from before encryption gets the
member who set its key, and one with no key yet has no owner, so any member can manage it.

WebChat's owner asked for removal before key rotation (R-002), so keys stay the same. A page accepts
a copy of a key only from a current member (D-015). Removing someone who made a channel or added
people would then lock others out on any new device. So the owner's browser wraps every key in the
project or group again, for exactly the people who stay. The server checks this under the project's
or the group's lock, and answers `409 stale_project` or `409 stale_group` when the page's view is
out of date. The page then reloads and tries once more (D-025).

Nobody can remove themselves, so nobody can leave. A person who leaves could not wrap the copies the
others need. Being removed sends no notification. A page that has the chat open closes it and says
why. Groups still cannot take new members, so someone removed from a group cannot come back (R-003).

Cost: people removed keep the keys they had. They could read later messages if they got them some
other way, for example from a copy of the database. The server stops sending them anything. Only a
browser that can open every key in the project or group can remove someone, and the request carries
every key wrapped for everyone who stays (D-011).

## Replies and reactions

### D-029: Replies carry a quote inside the envelope

Accepted 2026-11-01 in #2.

A reply's encrypted content holds the id and sender of the message it answers and up to 160
characters of its text, so the quote shows even when the original is not loaded. When the original
is loaded, the page shows the original, whose signature it checked, instead of the copy the replier
wrote. Tapping a quote scrolls to the original and highlights it. The ciphertext limit grew from
22,000 to 24,000 characters to make room for the quote.

Cost: the quote of a message that is not loaded is only as honest as the person who replied.

### D-030: Reactions are messages of their own kind

Accepted 2026-11-01 in #2.

A reaction is a row in `messages` with the kind `reaction`. Its envelope holds the emoji and the
message it is for, so the server sees only that someone reacted. Reusing messages gives reactions
the same sync, history paging, encryption and signatures, without a new table. The newest reaction
from a person to a message wins, and an empty emoji takes the reaction back. A reaction is never
urgent: the server refuses an urgent one instead of changing it (D-016). The page offers WhatsApp's
six quick emoji.

`conversations.last_event_id` follows every row, so sync notices reactions, while
`last_message_id` follows only messages. So reactions do not count as unread, do not move a chat up
the list, and do not replace its preview. They notify nobody: their push only wakes a tab the
recipient is looking at.

Cost: reactions count toward the 50 rows of a history page. A tab still running the app from before
reactions shows them as messages it cannot decrypt until it reloads (roadmap K-1).

### D-031: Project invites notify even while the app is open

Accepted 2026-11-01 in #2.

Being added to a project sends a push to every device of the person added, saying who added them.
The service worker shows it even while the app is open and focused, because being added is rare and
the page has no alert of its own for it. Project names are not encrypted, so the server can write
this text itself.

## GitHub connector

### D-032: GitHub links to an account and is not a way to sign in

Accepted 2026-11-01 in #1.

Each person can link a GitHub account through a GitHub OAuth App, with a state cookie and PKCE.
Linking adds to the existing account and does not replace the password sign-in, because the
encryption keys come from the password. The connector stays hidden until `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are set.

Cost: an OAuth App has one callback URL, so local development needs a second OAuth App.

### D-033: The server holds the GitHub token

Accepted 2026-11-01 in #1.

Polls run on the server, which is how an alert reaches a phone while every tab is closed, so the
token never reaches the browser. The server stores it encrypted with AES-256-GCM under a key derived
from `GITHUB_CLIENT_SECRET`, which lives only in the environment, so a copy of the database alone
cannot use it. Disconnecting deletes the token and revokes the grant on GitHub.

Cost: OAuth Apps have no read-only scope for private repositories, so the token has the `repo`
scope, although WebChat only reads pull requests. Pull request titles and repository names are not
end-to-end encrypted: the server keeps the latest lists and 50 recent events. Changing the client
secret makes everyone connect again.

### D-034: The server polls GitHub

Accepted 2026-11-01 in #1.

GitHub does not tell WebChat when a pull request changes, so the server asks with a GraphQL query
and compares the answer with the last one. Pull requests that left the lists cost a second query,
which finds out whether they were merged or closed. Polls of one account are at least a minute apart
when open tabs ask, 10 seconds apart when the user presses refresh, and 55 seconds apart for
scheduled runs, so a run that starts a moment early does not skip an account. Review requests,
reviews, comments from others, failed or fixed checks, conflicts, merges and closes become events.
One poll pushes at most three of them: the three most important. Polls start from open tabs, from a
timer on a self-hosted server (`GITHUB_POLL_SECONDS`, 120 by default), and from any scheduler that
calls `GET /api/github/poll` with `CRON_SECRET`, because Vercel Hobby cron jobs run only once a day.

Cost: alerts arrive up to a few minutes after the change. Each list shows at most 30 pull requests,
and only from github.com.

### D-042: A shared pull request is a message with a card inside

Accepted 2026-11-01 in #8.

The share button on a pull request sends an ordinary message of kind "message" whose encrypted
content carries a `pull` field: repository, number, title, URL and the state at that moment, as
`PullCardDTO`. The text of the same message says the same in words, so an older page, a push
notification and the chat list show something without knowing the card. The page shows the card
instead of the text. When reading content, the page rebuilds the link from the repository and
number and drops a card whose link differs, so a card can only lead to github.com.

Why: R-013 planned a new signed kind like reactions (D-030). A kind exists so the server can treat
rows differently, and reactions needed that: no unread count, no preview, no push. A shared pull
request should count, preview and push exactly like a message, so a field inside the envelope is
enough, and the server changes not at all. It sees one more message and nothing about pull
requests. The signature covers the envelope, so the card cannot be altered either (D-016).

Cost: the card shows the state at the time of sharing and does not update. The text of a shared
pull request is a stock sentence that the user does not write.

### D-046: New pull requests in a linked repository are shared by the author's browser

Accepted 2026-11-01 in #14.

A project's owner links GitHub repositories to the project, each with a channel. When a member's
poll finds a pull request of theirs in a linked repository that just became ready for review,
opened as ready or moved out of draft, the server queues it for that member. Their page claims it
and posts the same card as the share button (D-042), marked as automatic. Every card, shared by
hand or not, names who still has to review and who is assigned, as GitHub logins, and shows the
viewer's own login as "you". The share button stays.

Why: the server holds no chat key (D-015), so it cannot write an encrypted, signed message into a
channel. The author's browser can, so the card stays an ordinary message that only members read.
The author's own poll already sees the pull request, so WebChat reads nothing new from GitHub and
shares only what the author could share by hand. The claim lets one tab post it. GitHub drops a
reviewer from the review requests once they review, so the list is who still has to. A card the
page posts on its own leaves the author's read pointer where it was, because the author has not
seen the channel (`auto` in `SendMessageInput`).

Cost: only members who connected GitHub get their pull requests shared; anyone else's needs the
share button. A card goes out when the author's page next loads pull requests: within a minute
while a tab is open, otherwise when they next open WebChat. The server learns which repositories a
project links and which pull requests went into which channel. Everyone in the project sees each
shared title, even without access to the repository. Reviewers show as GitHub logins, not WebChat
names, and a card does not update when reviewers change later.

## Engineering process

### D-035: Pull requests, squash merges and plain commit messages

Accepted 2026-11-01 in #1 and #2.

Work happens on a branch and reaches main through a pull request. Main is squash-merged, and the
squash commit's subject is the pull request title followed by "(#N)". Commit messages follow
Conventional Commits: a subject of at most 50 characters in the imperative, and a body wrapped at 72
characters that says what changed and why. The owner does not want AI attribution lines in commits
or pull requests.

Cost: a branch's own commits do not reach main, so the squash commit's message must stand on its
own.

### D-036: Tests drive the real app

Accepted 2026-11-01 in 74d53ff.

`test/chat.test.ts` starts the real app on a random port with an in-memory PGlite database and
drives it over HTTP, with every client doing real encryption. A fake push service records what the
server sends, and `test/github.test.ts` runs against a fake GitHub. Each security promise has a
test: no plain text in the database or in pushes, altered messages rejected, access control, and
which devices get a push. `test/e2ee.test.ts` tests the cryptography on its own.

Cost: the tests in `test/chat.test.ts` run in order and share state, so a new test must fit into
that sequence.

### D-037: Changes people see are checked in a real browser

Accepted 2026-11-01 in #2.

Typecheck and tests do not show layout, focus or touch behavior. A change that people can see is
tried in a browser with at least two accounts, at desktop width and at 375 pixels, in light and dark
mode. The pull request says what was checked.

### D-038: These documents are the source of truth

Accepted 2026-11-01.

`AGENTS.md` is the entry point for people and agents, and `CLAUDE.md` imports it so Claude Code
loads it in every session. This file records decisions, and `docs/roadmap.md` records future work,
known issues and open questions. Each pull request updates them along with the change it makes.

Cost: these documents are only as good as their upkeep. A pull request that changes a decision
without updating this file misleads the next agent.
