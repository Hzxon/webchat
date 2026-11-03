# Decisions

This is the log of the decisions that shape WebChat. Each entry says what was decided, why, and what
it costs. Read the entries for the area you work on before you change how something works. Start at
[AGENTS.md](../AGENTS.md) if you have not read it yet.

## How to add or change an entry

- Add a decision in the same pull request as the change that makes it.
- Take the next free number. Numbers never change and are never reused.
- Say the decision first, then why it was made, then what it costs. Name the commit or pull request.
- Never delete an entry. When a decision replaces an older one, change the old entry's status line
  to "Superseded by D-0xx", say in the new entry what it replaces, and move the old entry under
  Superseded at the end of this file. An entry replaced only in part stays where it is.
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

Accepted 2026-11-01 in #6, changed in #18.

Every `/api` response carries an `X-WebChat-Build` header that names the running build. The page
remembers the first value it sees and reloads when a later response carries another, once the tab
is hidden or nobody has pressed a key, clicked, touched or scrolled in it for 30 seconds. The
reload opens the chat or Pull requests pane that was open, through the `/?chat=` link that a
notification click uses. On Vercel the name is the deployment id. Elsewhere it is `WEBCHAT_BUILD`,
or a hash of the built `index.html`, whose script tags change with every client build. Without a
built page, as in tests and in development, no header is sent and tabs never reload.

Why: a tab from before a deploy keeps its old code until it reloads. Old tabs showed each reaction
as a message they could not decrypt after #2 (K-1), and every later format change would do the
same. A check-in is the only channel to a tab (D-004), so the header rides on it.

A review on 2026-11-01 found that focus alone lost things that live only in the page: a hidden tab
reloaded with a draft in it, and a tab ringing an urgent alert reloaded at once, because the alert's
button has the focus. Now the reload also waits while the composer holds a draft, a message is
still sending or failed to send, or an urgent alert waits to be dismissed (`holdReloadWhile` in
`client/src/build.ts`).

The owner reported on 2026-11-01 that any click with a chat open sent them to the Chats tab. The
reload then waited only for the focus to leave an input, and the composer holds the focus while a
chat is open, so the next click anywhere reloaded the page, swallowed the click, and started over
on the Chats tab. Now no click fires it, and the user lands where they were (#18).

Cost: a deploy reloads every open tab once, which drops scroll positions and any open dialog. A tab
in use keeps the old build until it goes quiet for 30 seconds or is hidden. A tab with a failed
message or an alert nobody dismisses keeps the old build until they are dealt with. A self-hosted
server that restarts with the same build does not reload tabs, because the hash comes from the page,
not from the start time.

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
1 is end-to-end encryption, 2 is the GitHub connector, 3 is projects with replies and reactions, 4
is group owners (#4), 5 is key rotation, leaving and handing over (#13), 6 is sharing new pull
requests into projects (#14), and 7 pulls back delivered pointers that went past a chat's newest
event (D-022).

Two branches once both added a migration 2. The projects migration became 3 when its branch merged,
because a database that had already run the connector's migration 2 would have skipped it. When two
branches add migrations, the one that reaches main first keeps its number.

Cost: a mistake in a migration on main is fixed with a new migration, never by editing the old one.

### D-011: Limits live in one place

Accepted 2026-11-01 in 74d53ff, extended in 10ba6d8, #2, #4, #10 and #13, and after a review of
main on 2026-11-01.

`LIMITS` in `shared/types.ts` holds the sizes that the server enforces and the page respects: 4,000
characters per message, 160 per quote, 24,000 per ciphertext, the lengths of names, 50 messages per
history page, and 20 people added to a project or group at once. Express accepts JSON bodies of up
to 256 KB (`server/app.ts`), raised from 16 KB for encryption in 10ba6d8 and from 64 KB after a
review found that removing one person from a project of 20 people and 30 channels did not fit. That
caps batch requests: adding 20 people to a project sends every channel's key wrapped for each of
them. Removing someone sends a new key for every channel, wrapped for each person who stays, with
the old key inside (D-044). A copy takes about 110 bytes, so 256 KB holds about 2,300 copies, for
example 40 people with 58 channels. A body over the limit, or one that is not JSON, gets a JSON
error the page can show.

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

### D-052: The build supports iOS 15.4 and later

Accepted 2026-11-01 in #20.

`browserTargets` in `vite.config.ts` names the browsers the page and the service worker must run
in: Chrome and Edge 111, Firefox 114, and Safari and iOS 15.4. Vite's default starts at Safari 16.4.
With it, Lightning CSS wrote `max-width` media queries as `width<=` ranges. Safari before 16.4 drops
a query it cannot parse, so iPhones on older iOS got the desktop layout. iOS 15.4 is the floor
because the page needs `<dialog>` and `Array.prototype.at`.

Cost: the code cannot use CSS or JavaScript that iOS 15.4 lacks without a fallback. Push on iPhone
still needs iOS 16.4. Raising the floor is a deliberate change to `browserTargets`, and the README's
line moves with it.

### D-053: The chat fits the part of a touch screen still visible

Accepted 2026-11-02 in #21, extended in #22.

Safari on iPhone keeps the page at full height when the on-screen keyboard opens, and scrolls the
page up until the focused field shows. The chat fills the screen, so its header left the top.
`client/src/viewport.ts` sets the CSS variable `--visible-height` from the visual viewport, the
layout takes that height, and the page stays at the top. Dialogs centre in the same area and scroll
inside. This runs only while the chat layout shows, so the sign-in pages scroll as usual, and it
leaves a pinch-zoomed page alone.

Safari animates that scroll, and resetting it midway made the page drop and slide back up (K-25).
Since #22, on a touch screen with the keyboard closed, a field that takes the focus is moved far
above the screen. Safari then finds nothing to scroll to. The field comes back when the visual
viewport resizes, or after 400ms. Opening a chat on a touch screen no longer focuses the message
box, so the keyboard waits for a tap.

A touch screen also keeps `:hover` on the last thing tapped, so every hover style sits behind
`@media (hover: hover)`.

Cost: the field disappears for a moment as the keyboard starts to open. Whether Safari skips its
scroll depends on when it reads the field's position. Both changes were checked in Chromium, not
yet on an iPhone.

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

Accepted 2026-11-01 in 10ba6d8, extended in #4, #10 and #13.

Each chat has a random AES-256-GCM key. The member who creates it wraps a copy for every member with
a key from ECDH between the two of them, so a wrapped copy proves who made it. The page accepts a
copy only when the person who wrapped it is a member of the chat. The server checks that a new key
comes wrapped exactly once for every member. When someone joins, the member adding them wraps their
own copy for the newcomer (D-026, D-043). When someone leaves or is removed, the chat gets a new
key, wrapped by a member who stays (D-044).

Cost: a page opens a copy wrapped by someone who left only to make the chat's next key, never to
encrypt with it (D-044).

### D-016: Encrypt, then sign everything the server could change

Accepted 2026-11-01 in 10ba6d8. The kind joined the signed header in #2.

A message is encrypted with the chat key, then signed with the sender's ECDSA key. The signature
covers the ciphertext and a header with the chat, the key id, the sender, the urgent flag, the
client id, and the kind for kinds other than "message". The page rejects a message whose header the
server changed and shows it as "could not be decrypted".

The kind is in the header only for new kinds, so messages signed before kinds existed still verify.
A new field that the server stores and the page acts on must join the header the same way.

The page keeps the text of messages it has decrypted, so it does not decrypt them again on every
check-in. It keeps them with the signed fields and the signature they were checked against, and
checks a message again when the server sends it with any of them changed.

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

Until the check, the page also trusts nothing signed or wrapped with the changed keys. It refuses to
open a new chat key that person wrapped, so it never sends under a key the server could know. It
shows their new messages as unreadable, and the service worker shows their pushes without text. A
chat key the device stored before the change still works. A security review of main on 2026-11-03
found that only wrapping was blocked.

These pins stay on the device when someone signs out or signs in, so a swap made while nobody was
signed in still shows a warning. They hold only fingerprints of other people's public keys. Until a
review on 2026-11-01, every sign-in erased them along with the account's keys.

Cost: a device trusts the first keys it sees for a person without proof. After someone's keys
change for a real reason, their new messages stay unreadable until the user checks the code. The
page keeps what failed to open, and opens it again after the check, without a reload (K-26).

### D-019: Accounts and chats from before encryption upgrade once

Accepted 2026-11-01 in 10ba6d8.

An account created before encryption has `auth_version` 1. Its owner signs in once with the
password, which the server checks against the old hash before storing the hash of the new login
key. That request is the only one that ever carries a password. Old messages stay readable and show
"Not encrypted". A chat from before encryption gets its key from the first member who sends a
message, and the first key set wins.

The server refuses messages without encryption, so a new one can only come from someone who writes
to the database. Such a message never alerts, and every preview of it, in toasts, notifications and
the chat list, starts with "Not encrypted:".

### D-020: Known limits of the encryption

Accepted 2026-11-01 in 10ba6d8, extended in #1, #2, #4, #10, #13, #14, #17 and #33.

WebChat accepts these limits and lists them in the README:

- The page runs the code the server sends, so an operator who changes the app could read messages.
- Metadata stays visible to the server: who talks to whom and when, group, project and channel
  names, who is in which project or group and who added them, who owns each project and group, who
  left, when a chat got a new key, display names, whether a message is urgent, that someone
  reacted, and roughly how long a message is: the size band it was padded to (D-059).
- Pull request titles and repository names are not end-to-end encrypted (D-033).
- Which repositories a project links, and the cards from GitHub in its channels. The server
  writes those cards in plain text, so a server that was changed could write fake ones (D-050).
- The member list that a new channel's key is wrapped for comes from the server. The New channel
  dialog shows it so people can check it. The same holds for the people a new key is wrapped for
  after someone leaves (D-044).
- People who leave or are removed keep the keys they had, so they could read the messages from
  before if they got them another way, for example from a copy of the database (D-044).
- Someone who writes to the database can add messages without encryption under any member's name.
  They show as "Not encrypted" and never alert (D-019).

Cost: a feature that shows the server something new must add it to this list and to the README.

### D-044: A new key when someone leaves or is removed

Accepted 2026-11-01 in #13. Replaces the part of D-039 that kept keys the same.

When someone leaves a chat or is removed from it, the chat gets a new key, and the person who left
never gets a copy. The browser that makes it wraps it for everyone who stays and encrypts the old
key with the new one. The server keeps these links in `key_links`, and `ConversationDTO.keyLinks`
hands them to members. A browser that holds the current key opens each earlier key in turn, so the
whole history stays readable. Each message names its key in its signed header (D-016). Someone added
after a rotation gets the current key and reads the history the same way (D-026, D-043), which
answers the open question of roadmap R-002.

- Removal: the owner's browser makes the new key of every channel, or of the group, in the request
  that removes the person. The server checks under the project's or group's lock that each new key
  names the current one in its link and is wrapped for exactly the people who stay.
- Leaving: the person who leaves cannot make keys for the others. The server marks each chat they
  left with `needs_new_key` and refuses messages there with `409 needs_new_key`. The first member's
  browser that checks in, or sends, makes the new key with `PUT /conversations/:id/key`. The first
  one wins; the others get `409 stale_key` and take its key.
- The person who left may have wrapped a member's copy of the old key. The browser making the new
  key opens that copy without the membership check of D-015. The old key only goes inside the new
  one and never encrypts again, so a forged copy could only spoil the history, not expose new
  messages.
- A page never encrypts with a key that a link says was replaced.

Why: removal kept keys the same (D-039), so people removed could read later messages if they got
them another way. Wrapping every earlier key again for everyone who stays would grow with each
rotation. One link per rotation does not.

Cost: anyone with the current key reads the whole history, as before. After someone leaves, nobody
can send in that chat until a member's browser has made the new key. That waits for a member to be
online, or for a security code check when someone's keys changed (D-018). A service worker that has
not seen a new key yet shows "New encrypted message" for a push, until a page opens the key (D-017).

## Messaging

### D-021: The sync fingerprint is the change detector

Accepted 2026-11-01 in 74d53ff, extended in #2, #4 and #13.

`db.stamp` builds one string per user from a single query. It covers the sum of the newest event
ids in their chats, the read and delivered pointers, how many chats they are in, the sum of the
times their members joined those chats, how many chats have keys, the sum of the times their keys
were replaced, a hash of who owns each of their projects and groups, how many people there are and
how many have keys, and who is online. A check-in whose stamp matches answers "unchanged" without
loading anything else.

Cost: any state that pages must see has to change this string, or pages miss it until something
else changes. #2 added the newest event ids, so reactions show up, and the member count, so new
members show up. #4 replaced the member count with the sum of join times, so one person leaving and
another joining between two check-ins still show up. #13 added new keys (D-044) and owners (D-045).
Owners go in as a hash, not a sum, so two handovers at once cannot cancel out.

### D-022: Receipts are per-member pointers

Accepted 2026-11-01 in 74d53ff.

Each member of a chat has a delivered pointer and a read pointer. Messages with an id at or below a
pointer count as delivered or read. Check-ins move the delivered pointer, and opening a chat moves
the read pointer. The service worker reports delivery when a push arrives, so the sender sees
"delivered" even while every tab of the recipient is closed.

A pointer never moves past the chat's newest event, whatever id a client sends. Before a review on
2026-11-01 the delivered route stored any id, and one near the top of the INTEGER range overflowed
the sum in the sync fingerprint (D-021), which stopped every member of the chat from loading.
Migration 7 pulls back pointers that went too far, and the fingerprint adds pointers as BIGINT.

### D-023: Urgent messages ring until acknowledged

Accepted 2026-11-01 in 74d53ff.

The sender marks a message urgent with the bell next to the message box, and the urgent flag is
signed (D-016). The recipient's open tab shows a full-screen alert and rings until they dismiss it,
even with message sounds off. The push waits up to 3 days for an offline device instead of 1, and
the notification stays until the user acts on it. Reactions cannot be urgent (D-016, D-030).

### D-047: Safari gets no silent pushes

Accepted 2026-11-01 after a review of main.

WebKit, which runs Safari and every web app on iPhone and iPad, revokes a push subscription after a
few pushes that show no notification. The service worker shows nothing for a push that arrives
while the user looks at the app (D-007), so an iPhone used with the app open lost its push after
three messages, urgent alerts included. Now the server sends no push to a Safari endpoint while it
knows the user is looking, except urgent ones, which always show. That tab checks in every 3
seconds instead, like a tab without push. If a push reaches Safari while a tab is focused anyway,
the service worker shows it. `showsEveryPush` in `shared/types.ts` tells Safari endpoints apart by
Apple's push host.

Cost: an open Safari tab checks in more often, and a message can take up to 3 seconds to show
there.

### D-048: A check-in says when it left messages behind

Accepted 2026-11-01 after a review of main.

A check-in returns at most 500 messages, those after the cursor first, and its queries each see
their own moment. A message could therefore be counted in the fingerprint it returned without being
in the answer: one past the 500th, or one that committed while the answer was being built. Then
every later check-in answered "unchanged" without it. Now the server compares the newest message id
with the answer's cursor. When messages are missing, it answers `more: true` with an empty
fingerprint, and the page checks in again at once, up to 10 rounds in a row. `GET /api/bootstrap`
reads the fingerprint before anything else, so a change during the load makes the first check-in
answer "changed".

Cost: catching up after a long sleep takes several full check-ins in a row.

### D-049: Only messages new to the user alert

Accepted 2026-11-01 after a review of main.

A check-in re-sends the last 15 seconds of messages, and a person added to a project gets its
history (D-026). The page used to alert for every message it had not handled since it loaded, so
both rang again: a reload replayed recent alerts, and joining a project played a sound for every
old message and rang its old urgent ones. Now a message alerts only when its id is above both the
cursor the page loaded with and the user's own read pointer in that chat, and it is encrypted
(D-019).

Cost: a message that commits more than a moment after a newer one while the page loads shows up
without an alert.

### D-051: Drafts and unsent messages stay on the device

Accepted 2026-11-02 in #19.

What someone types in a chat's message box, and every message the server has not confirmed, stay in
the device's IndexedDB next to the account's keys. A draft comes back when its chat opens again:
after a closed tab, a reload, or a visit to another chat. A message that was sending or failed comes
back in its chat as "Not sent", with a toast that names the chat, unless the chat's history shows
that the server has it after all. The page never sends it again by itself; the person decides with
"Tap to retry", which keeps the message's client id so the server stores it once (D-061). A Remove
button next to it drops the message. While a message is still sending, the tab asks before it
closes or reloads. Signing out removes drafts and unsent
messages with the keys.

A tab holds a Web Lock while it keeps unsent messages, and each one names its tab. A tab that opens
takes over only the messages of tabs that hold no lock, so it never shows one that another open tab
is still sending.

Why: drafts and messages still sending lived only in the page. Closing the tab, reloading it, or
opening another chat dropped them without a word. A test on 2026-11-01 lost both. The person they
were for never got them, and the writer believed they had.

Cost: drafts and unsent messages sit on the device unencrypted until they are sent or the user
signs out, so anyone with the device's files can read them. A browser without Web Locks, such as
Safari before 15.4, can show the same unsent message in two tabs. A message that reached the server
as its tab closed shows as not sent if newer messages push it off the chat's first page, until a
retry brings back the stored copy (D-061).

### D-056: A 2xx answer whose body does not parse is a failed request

Accepted 2026-11-02 in #27.

Every route answers with JSON, or with 204 and no body. `request` in `client/src/api.ts` treats a
2xx answer whose body fails to parse as a failed request and throws an `ApiError` that carries the
status. Before, it returned `{}` as success. The sync loop read a cursor of NaN from that, which no
later `Math.max` repairs, so every check-in asked from 0, and a user with more than 500 messages
stopped getting new ones until a reload (K-7). On a failed status the body still falls back to `{}`,
so the default error message stands.

Cost: a route that answers 2xx without a JSON body must use 204, or every call to it fails. A send
whose answer breaks off now shows as not sent, like one whose connection dropped, although the
server stored it. A retry brings back the stored copy (D-061).

### D-061: A sender's client id names one message per chat

Accepted 2026-11-03 in #35.

Every send carries a client id the page made, signed into the envelope (D-016). A unique index on
(chat, sender, client id) in `webchat.messages` makes it name one message per chat. When a send
repeats a client id its sender used in that chat before, `db.insertMessage` stores nothing and
returns the stored message, the route answers 200 instead of 201, and no push goes out.
`retryMessage` in `client/src/chat.ts` keeps the client id of the message it sends again.

Why: a send whose answer was lost, to a dropped connection or a 2xx that broke off (D-056), showed
as not sent although the server had stored it. "Tap to retry" sent it under a new client id, so
the server stored a second copy, and an urgent one alerted everyone twice (K-9).

Cost: migration 10 fails on a database that already holds two messages with the same chat, sender
and client id, and the server then stops at start. The page's retries never made such rows; only
two tabs sending the same stored message in a browser without Web Locks could (D-051). A repeat
answers with the first copy's envelope, not the one just sent, which the page never needs to read.

### D-069: A check-in answer older than a change on the page is dropped

Accepted 2026-11-03 in #44.

`client/src/store.ts` counts the changes the page makes to its chats and projects ahead of the
server: a chat or project it adds, changes, leaves or deletes. A check-in notes the count when its
request goes out. When the count moved before the answer is applied, `applySync` applies nothing,
and the page checks in again at once with the same stamp and cursor. `reloadAll` fetches again the
same way, because its callers go on with what it loads.

Why: the server builds an answer from the chats as they were when the request arrived. An answer
that left before a new chat committed, but came back after the page opened it, closed the chat
with "It was deleted, or you were removed" until the next check-in (K-15). The same race brought
back a chat the page had just left or deleted, and put back a project's old member list.

Cost: every change on the page that overlaps a check-in costs one more check-in. A change that
reaches the store some other way must go through the counted actions, or a late answer undoes it
until the next check-in.

## Projects and channels

### D-054: iPhones without Web Push get alerts through the Bark app

Accepted 2026-11-02 in #23.

An iPhone on iOS 15 can never get Web Push, which Apple added in iOS 16.4, and an app of our own
could push only through the paid Apple Developer Program. So WebChat alerts such phones through
Bark, a free, open-source notification app whose author publishes the APNs key its pushes are
signed with. The server stands in for Bark's own server: the bell dialog makes a server URL with a
secret token in it, the person types it into Bark, and the app registers its APNs token there.
From then on, whenever a Web Push would go to the person's other devices (D-007), the server also
sends an APNs push to the phone, signed with Bark's key, with what a Web Push carries before it is
decrypted: the chat name, the sender's name, urgency and the unread count, never the message text,
which the server does not have (D-014). With encryption turned on in the dialog, the person types
a second key into Bark, and the alert reaches Apple as AES-256-GCM ciphertext under a placeholder
that Bark replaces on the phone. One provider token signs every push for an hour and is shared
through the database, because Apple refuses tokens refreshed more often than every 20 minutes and
serverless instances start often.

Why: the students the product is for keep old phones. Relays through Telegram and similar services
were turned down because they put another service and account in the path. An app of our own
signed with a free Apple ID stops after 7 days, a jailbreak wants a computer or a tap after every
reboot, and a page kept alive with silent audio costs battery and dies with any other sound. Bark
needs an App Store install and nothing running on the phone.

Cost:

- The route depends on Bark: its app, and a key its author calls permanent but could withdraw. If
  it stops, these alerts stop until another route is built, and nothing else is affected.
- The operator downloads the key from Bark's documentation into `BARK_APNS_KEY`. The repository
  never carries it.
- Apple sees when a push goes to the phone and its collapse id, and without encryption also the
  chat and sender names. The Bark app sees the decrypted alert. The README lists this.
- A Bark alert cannot mark the message delivered; the tick comes when the person opens WebChat.
- The link's state is not in the sync fingerprint (D-021). The dialog reads it when it opens, so
  another tab of the same account shows it on its next opening of the dialog.

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
it for the newcomer. Each key holds the one it replaced (D-044), so the newcomer can read every
earlier message, as when joining a Slack channel. Their read pointers start at the newest message,
so the history does not count as unread. Being added sends a notification (D-031). Groups work the
same way since #10 (D-043).

Cost: only a member whose browser can open every channel key can add people. The server records who
added whom.

### D-027: Slack-style channel names

Accepted 2026-11-01 in #2.

Channel names use lowercase letters and digits in any script, joined by single hyphens, up to 40
characters, and are unique within their project. The page turns what people type into that form,
so "Slides & Design" becomes `slides-design`. Every project starts with `#general`.

### D-039: Owners remove people and delete, before key rotation

Partly superseded by D-044 and D-045: removal now gives each chat a new key, and people can leave.
Owners still remove people and delete. Accepted 2026-11-01 in #4. Replaces D-028.

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
why. Groups could not take new members at first, so someone removed from a group could not come
back. Since #10, any member can add them again (D-043).

Cost: people removed keep the keys they had. They could read later messages if they got them some
other way, for example from a copy of the database. The server stops sending them anything. Only a
browser that can open every key in the project or group can remove someone, and the request carries
every key wrapped for everyone who stays (D-011).

### D-043: Any group member adds people, and they read the history

Accepted 2026-11-01 in #10, extended in #13. It answers the open question of roadmap item R-003.

Groups take new members the way projects do (D-026). Any member can add up to 20 people at once with
the Add people button in the group's header. That member's browser opens its own copy of the group's
key and wraps it for each newcomer. Each key holds the one it replaced (D-044), so newcomers read
every earlier message. Their read pointers start at the newest message, so the history does not
count as unread. Being added sends a push, as for projects (D-031). Someone removed from a group can
come back this way.

The server checks under the group's lock that the copies cover exactly the people added. It also
checks that the group still has the key the copies were made from, and that the person adding is
still a member. Otherwise it answers `409 stale_group`, and the page reloads and tries once more
(D-025). A group from before encryption that has no key yet takes new members without one. Its
first message then keys it for everyone (D-019).

Why: a late teammate needed a new group, and someone removed by mistake could not come back (D-039).
Hiding the history from newcomers would need a new key for every join (R-002). With one key per
chat, the server could only choose not to send old messages, which the encryption does not enforce.
As in projects, anyone in the group can add people, and only the owner can remove them.

Pages now alert only for messages after the user's read pointer. A newcomer's first check-in brings
the chat's messages after their sync cursor, and each of them used to ring or notify, urgent ones
too. The same burst hit people added to a project. The rule also stops alerts on one device for
messages already read on another.

Adding people to a project now also checks under the lock that the person adding is still a member.
Before, someone removed at that moment could still add people, with copies the newcomers' browsers
refuse.

Cost: any member can let someone read the whole history, and only the owner can take them out again.
The other members see a newcomer only in the member list; the chat shows no note (roadmap R-017).
The server knows who added whom in a group only from who wrapped each copy, until a new key
replaces every copy (D-044).

### D-045: People leave on their own, and owners hand over

Accepted 2026-11-01 in #13. Replaces the rule of D-039 that nobody can leave.

Any member can leave a project or group from its members dialog, and a member who stays makes each
chat's next key (D-044). The owner can make another member the owner, and only then leave, so a
project or group always has an owner among its members. The last person in a group deletes it
instead of leaving. Only the owner removes people, deletes, or hands over, as in D-039. A group
without an owner stays open to any member, who can also give it one.

`projects.created_by` and `conversations.created_by` name the owner from migration 5 on. The API
calls the field `ownerId`, since it is no longer always the person who made it. Leaving and handing
over send no notification, like removal.

Cost: once a project or group is handed over, nothing records who made it. Someone who left can
come back only when a member adds them again (D-026, D-043).

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

Cost: reactions count toward the 50 rows of a history page. So the page pages from the oldest row it
fetched, not the oldest message it shows, and keeps going while pages bring only reactions. A tab
still running the app from before reactions shows them as messages it cannot decrypt until it
reloads (roadmap K-1).

### D-031: Project invites notify even while the app is open

Accepted 2026-11-01 in #2, extended in #10.

Being added to a project sends a push to every device of the person added, saying who added them.
The service worker shows it even while the app is open and focused, because being added is rare and
the page has no alert of its own for it. Project names are not encrypted, so the server can write
this text itself. Since #10, being added to a group sends the same kind of push, which opens the
group (D-043).

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
On Vercel, the database is that scheduler (D-057).

Cost: alerts arrive up to a few minutes after the change. Each list shows at most 30 pull requests,
and only from github.com.

### D-057: On Vercel, the database calls the GitHub poll every 2 minutes

Accepted 2026-11-02 in #29.

Vercel Hobby runs a cron job at most once a day, and refuses to deploy one that runs more often. So
on Vercel nothing polled GitHub while every tab was closed, and the connect card still promised
alerts (K-5). The database now keeps the clock. When the server starts on Vercel, it makes sure a
Supabase Cron job named `webchat-github-poll` exists. Every 2 minutes, pg_cron runs it, and pg_net
calls `GET /api/github/poll` with a bearer secret that the server generated and keeps in
`webchat.meta`. The job reads the secret on every run, so the secret is not in the job's text. The
server enables pg_cron and pg_net itself, which Supabase allows its `postgres` role. A job that
already matches is left alone, even one the owner deactivated. So every start checks it cheaply,
and a deleted job comes back.

Every `pollAll` run records when it started. The pane promises alerts with every tab closed only
while the last run is less than 10 minutes old: five missed runs of the 2-minute clock. Otherwise
the connect card says alerts need an open tab, and the connected pane shows a banner. A tab's own
poll does not count, because it stops when the tab closes. A self-hosted server polls once at
start, so a fresh one does not show the banner before its timer first runs.

Why: alerts with every tab closed are why the server holds the token (D-033), and they must stay
free (D-003). The database is already part of the free setup, can run a job every minute, and needs
no account or secret from the owner. GitHub Actions schedules run at most every 5 minutes, are late
when GitHub is busy, and stop after 60 days without activity in a public repository.

Cost: the server changes the owner's database: it enables two extensions and adds a job. The job
adds up to 720 function calls a day, about 2% of Hobby's monthly million. With another Postgres, or
where the role may not enable the extensions, the server logs why and the pane says so; a scheduler
with `CRON_SECRET` still works. Anyone who can read the database can start polls with the secret,
which poll an account at most once a minute anyway. A paused Supabase project stops the clock along
with everything else.

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

### D-050: Projects link repositories through a GitHub App, and the server writes their cards

Accepted 2026-11-01 in #17. Supersedes D-046.

A project's owner links a repository by installing the WebChat GitHub App on it and signing in to
the app once. The server lists the repositories the owner reaches through the app, revokes that
sign-in's token at once, and lets the owner link only those, for half an hour. GitHub then sends a
signed webhook for every pull request event in the repository. When a pull request opens, is ready
for review, is reopened, merged or closed, the server writes a card into each channel that links
the repository, and pushes it to every member like a message. The card is a message of kind
"github" with no sender, whose body is the card as plain JSON. Pages show it as GitHub's, with a
"Not encrypted" mark, and rebuild its link from the repository and number, as for a shared card
(D-042). A card names who still has to review and who is assigned, as GitHub logins, and the
viewer's own login reads "you", as under D-046. The share button stays. The OAuth App stays for
each person's Pull requests pane only (D-032 to D-034).

Why: a team wants its pull requests in its channel whoever opens them, at once, even with every tab
closed. Under D-046 they came only from members who connected GitHub, and only when their browser
next polled. A GitHub App gets webhooks, so nothing has to poll. It reads pull requests only, where
the OAuth App needs the `repo` scope. The sign-in proves the owner can see each repository they
link, which a typed name did not. The server holds no chat key (D-015), so it cannot write an
encrypted, signed message. It already reads pull request titles from GitHub for the pane (D-033),
so writing them in plain text tells it nothing new. With the token revoked once used, no token of
the app exists anywhere.

Cost:

- The cards are the first messages the server writes. They are not end-to-end encrypted, and a
  server that was changed could write fake ones. Their links still lead only to github.com.
- The server owner registers a GitHub App, and webhooks need a public address. Local development
  of linking needs a tunnel, or signed test deliveries.
- A card shows the pull request as the webhook described it, without checks, review decision or
  conflicts, and it does not update.
- Only someone who can install the app on a repository can link it. A repository in an
  organization needs an owner of that organization to install it.
- Migration 8 dropped the links made by typing a name under D-046.
- Neither the pane nor the cards name a team asked to review. Reading a team needs `read:org` from
  the OAuth App, and a query that asked for one without it made GitHub refuse the whole poll.

### D-060: The pane names an organization that hides its pull requests

Accepted 2026-11-03 in #34.

An organization that restricts OAuth Apps hides its pull requests from the token until one of its
owners approves WebChat (D-033). GitHub still answers the poll with the other pull requests, and
adds one FORBIDDEN error for each one it left out. The error's message names the organization;
nothing else in the answer does. `graphql` in `server/github.ts` now returns those errors next to
the data, and the poll keeps the organizations they name in the stored lists as
`hiddenOrganizations`. The pane names them in a banner that links to GitHub's page on asking the
owners for approval, and the connect card says an organization may need to approve the app.

Why: course repositories often live in an instructor's organization, and GitHub turns the
restriction on for new organizations. Without the banner the pane said "You have no open pull
requests" to a student whose pull requests were all hidden, and nothing told them that only an
owner could change that. Only the owner's approval can fix it, so the pane's job is to say so and
to whom.

Cost: the server recognizes the restriction by the text of GitHub's error message, which no
schema fixes. If GitHub rewords it, the banner stops showing and the pull requests go silently
missing again, as before. An organization that enforces SAML single sign-on hides its pull
requests the same way, but its error names no organization, so the pane says nothing for it. The
banner was built against GitHub's answer as reports describe it, not against a real organization.

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

### D-062: An item is claimed with a draft pull request before any code

Accepted 2026-11-03 in #37.

A session that picks a roadmap item claims it on GitHub before it reads or writes code: a branch
named after the item, an empty commit, and a draft pull request whose title or body names the item.
`scripts/claim.sh` does this in one command and refuses an item that an open pull request already
names. Other sessions check the same list before they start. A draft that is abandoned is closed,
so its item frees up. Decision and roadmap numbers stay sequential; a pull request that merges
second renumbers its own entry when it resolves conflicts.

Why: since #12, AGENTS.md said to open the draft "as soon as the branch exists", but every session
read that as "once there is something to show". On 2026-11-03, #35 and #36 both fixed K-9: each session opened
its draft at the end, three minutes apart, and the second one's work was thrown away. GitHub's open
pull requests are the only state every session can see, so the claim has to be there, and first.

Cost: every pull request starts with an empty commit, which the squash merge drops. A claim depends
on the item id appearing in the branch name and the pull request text, so the script insists on
both. Numbers for decisions still race, which costs the loser a rename at merge time; a CI check
that fails on a duplicate `D-0xx` heading would catch that earlier, and is not written yet.

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

### D-055: Versions follow Semantic Versioning and stay at 0.y.z for now

Accepted 2026-11-02 in #25.

WebChat follows Semantic Versioning 2.0.0. While it is in early development, the major version
stays 0, and any release may change anything. The first release is 0.1.0, as the SemVer FAQ
suggests.

A version speaks to the people who run WebChat. What they rely on across an upgrade: the settings
and deploy steps in the README, the Node version `engines` pins (D-013), the data already stored,
which the migrations upgrade in place (D-010), and tabs that still run the previous build. A change
is breaking when the person who runs WebChat must act during the upgrade, such as setting a new
variable, or when stored data or open tabs stop working.

The type in a pull request title sets the next version, because the squash merge makes the title
the commit subject on main (D-035):

- `fix` bumps the patch, as in 0.1.0 to 0.1.1.
- `feat` bumps the minor, as in 0.1.0 to 0.2.0.
- A breaking change, marked with `!` after the type or a `BREAKING CHANGE:` footer, also bumps the
  minor while the version is below 1.0.0. `bump-minor-pre-major` in `release-please-config.json`
  does this.
- Other types, such as `docs`, `ci` and `chore`, make no release on their own.

Release Please runs on every push to main, from `.github/workflows/release-please.yml`. It keeps one
release pull request open, which updates `package.json`, `package-lock.json` and `CHANGELOG.md`.
Merging it tags that commit as `v0.y.z` and publishes a GitHub release. Vercel does not build that
commit (D-058). Nobody edits the version or the changelog by hand, so parallel pull requests never
conflict over them. Reaching 1.0.0 is the owner's call (Q-4). A commit with `Release-As: 1.0.0` in
its body makes the release pull request propose that version.

Cost: a title with the wrong type gives the wrong version and changelog line. To fix one before the
release, add a `BEGIN_COMMIT_OVERRIDE` section to the merged pull request's body. The Vercel
deployment runs main, so it is usually ahead of the latest version. Release Please opens its pull
request with the workflow's `GITHUB_TOKEN`, so the repository setting "Allow GitHub Actions to
create and approve pull requests" must be on, and that pull request starts no other workflow.

### D-058: Vercel skips the build of a release commit

Accepted 2026-11-02 in #30.

Vercel builds every push to main (D-041). A release commit from Release Please changes only
`package.json`, `package-lock.json` and `CHANGELOG.md`, and nothing at runtime reads them. Its build
shipped the same app again, from Hobby build minutes. `scripts/ignore-build.sh`, the Ignored Build
Step in `vercel.json`, skips a commit whose message starts with `chore(main): Release `.

The release pull request still waits for the owner. It collects every `feat` and `fix` since the
last release, so the owner merges it when a set of changes is worth a version. A workflow step that
merged it after every push was tried in #30 and set aside. Every `feat` would have bumped the minor
at once. A wrong type in a title would have shipped before `BEGIN_COMMIT_OVERRIDE` could fix it. And
the workflow needed a second Release Please run to tag, because a push made with `GITHUB_TOKEN`
starts no workflow run.

Cost: Vercel still clones the repository and records a canceled deployment for each release commit.
A commit on main whose message starts like a release commit never deploys, so only Release Please
may use that title.

### D-059: Message content is padded to a few fixed sizes

Accepted 2026-11-03 in #33.

Before `encryptMessage` encrypts the content, it pads it to the smallest power of two from 256
bytes that holds it, so a ciphertext is 256, 512, 1,024 bytes and so on, plus the AES-GCM tag. The
server learns which band a message falls in, not its length. A reaction, a reaction taken back and
a short message all land in the first band and look the same, which is what the README promises
(K-8). The padding is one 0x80 byte and then zeros, inside the AES-GCM ciphertext, so it is
authenticated with the content. The content is JSON, which ends with `}` and never holds a raw
zero byte, so `decryptContent` tells padded content from the content of messages sent before this
by the last byte, and both still open. Nothing in the signed header changes, so every old
signature still verifies (D-016). A new band at the top raised `LIMITS.ciphertextLength` to the
32 KB band.

Doubling bands were chosen over a fixed step, such as 256 bytes, because a step still shows a long
message's length to within the step. A few bands reveal less and cost at most half the band in
padding.

Cost: every message costs at least 272 bytes of ciphertext, and a message from about 1,000 to
1,800 bytes of content, which fitted in a push before, now pads past the 3,000-byte push payload
(D-017) and shows "New message" on the lock screen. Messages sent before this change keep their
exact lengths in the database.

### D-063: A check fails a pull request that repeats a decision or roadmap id

Accepted 2026-11-03 in #38.

The `doc-ids` workflow (`.github/workflows/doc-ids.yml`) runs on every pull request. It fails when
`docs/decisions.md` has two `### D-0xx:` headings with the same number, or `docs/roadmap.md` has two
`### K-n:`, `### R-nnn:` or `### Q-n:` headings with the same id. It is a few lines of `grep` and
`sort | uniq -d`, so it adds no dependency. The error names the file and the repeated id, and the
pull request that merges second renumbers its own entry, as AGENTS.md says.

Why: sessions take "the next free number" in parallel, and the numbers raced twice on 2026-11-03.
Git does not see it as a conflict when the two entries land in different places in the file, so the
repeat reached main unless someone read both pull requests. A check on the pull request finds it
before the merge.

Cost: the check sees only the pull request's merge with main at the time it runs. Two open pull
requests that take the same number both pass until one merges, and GitHub does not run the second
one's check again on its own. The second pull request has to be updated from main first, which
runs the check. Mark the check required in the branch rules, with "Require branches to be up to
date", or a red result will not stop the merge.

## Superseded

Decisions that no longer hold. They keep their numbers and reasons for the record. Read the entry
that replaced each one instead.

### D-028: No leaving or removal before key rotation

Superseded by D-039. Accepted 2026-11-01 in #2.

Nobody can leave a project or be removed from one yet. A removed member would still hold every
channel key, so removal without key rotation would only stop the server from sending them new
messages. Groups also cannot take new members after they are created; projects can.

Cost: a mistaken add cannot be undone in the app (roadmap R-002), and a teammate who joins late
needs a new group (roadmap R-003).

### D-046: New pull requests in a linked repository are shared by the author's browser

Superseded by D-050. Accepted 2026-11-01 in #14.

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
