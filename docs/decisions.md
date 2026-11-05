# Decisions

This is the log of the decisions that shape WebChat. Each entry says what was decided, as it stands
today, why, and what it costs. Read an entry when a rule, a code comment or a roadmap item names
its number: grep for `D-021`. Do not read the file top to bottom. The constraints each area must
hold are in `.claude/rules/`, one line per constraint, each naming its decision. Start at
[AGENTS.md](../AGENTS.md) if you have not read it yet.

## How to add or change an entry

- Add a decision in the same pull request as the change that makes it.
- Take the next free number, and reserve it when you claim, with
  `scripts/claim.sh K-12 "<title>" D-077`, so that no other session takes it. Numbers never change
  and are never reused.
- Put a new entry at the end of its topic section, never at the end of the file. Git merges this
  file with the union driver (`.gitattributes`, D-076), so two pull requests that each add an entry
  at the same place merge without a conflict. The doc-ids check still fails a repeated number.
- An entry is the decision as it stands, then why it was made, then what it costs: at most 12 lines
  of text. The status line names the date and the commit or pull request that made it. When a later
  change alters the decision, rewrite the entry to the new state and name that pull request; do not
  append what changed. Git keeps the history (D-090).
- When the decision adds a constraint for the people who edit an area, add one line to that area's
  file in `.claude/rules/`, ending with the decision number.
- Never delete an entry. When a decision replaces an older one, change the old entry's status line
  to "Superseded by D-0xx", say in the new entry what it replaces, and move the old entry under
  Superseded at the end of this file. An entry replaced only in part stays where it is.
- An entry is Accepted once the change that makes it is on main. A decision agreed but not built yet
  is Proposed.

Commits are short hashes on main. Pull requests are numbered, as in #2.

## Product and scope

### D-001: Audience and product direction

Accepted 2026-11-01.

WebChat exists because urgent WhatsApp messages reached friends late (74d53ff). Its main users are
college students who run several group projects at once. The product grows toward three tools they
already know, in one place: chat like WhatsApp, projects and channels like Slack, and task tracking
like Jira. The task board is set aside for later; it is roadmap item R-001.

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

### D-083: A work tool's palette and type

Proposed 2026-11-04 for R-022, the first step of the rebrand.

The page uses neutral grays with one indigo accent (`#4f46e5` light, `#818cf8` dark). Success has
its own green, `--ok`, so passed checks, added lines and the online dot do not borrow the accent.
The sidebar is tinted and sets `--panel`, `--panel-2` and `--hover` to its own shades, so every row
and field inside it follows without its own rule. The content area is white, or near black in dark
mode. Panels are flat: a 1px line, no shadow. Only dialogs, toasts and the reaction tray cast one.
Type is 14px with a 1.35 line height, code uses the `--mono` stack, and every corner, avatars
included, has the 6px `--radius`. Small status dots stay round. The fonts are the system's, so the
page loads nothing from a font host.

Why: the features are for project work, but the look said consumer messenger. Colors, type and
shapes live in `styles.css` alone, so this step changes no behavior.

Cost: people and projects now share one avatar shape. The favicon, the installed app's icon, the
`theme-color` meta tag and one avatar color are still teal. Bubbles stay until R-023.

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

Every `/api` response carries an `X-WebChat-Build` header that names the running build. On Vercel
the name is the deployment id. Elsewhere it is `WEBCHAT_BUILD`, or a hash of the built `index.html`.
Without a built page, as in tests and in development, no header is sent and tabs never reload. The
page remembers the first value it sees. When a later response carries another, it fetches `/` and
compares the bundle files under `/assets/`. A tab with the same files keeps the new name and asks
the service worker to update instead (K-36). A tab whose page loads a new file reloads once it is
hidden or idle for 30 seconds, and it waits while the composer holds a draft, a message is sending
or failed, or an urgent alert waits (`holdReloadWhile` in `client/src/build.ts`). The reload opens
the chat or Pull requests pane that was open, through the `/?chat=` link of a notification click.

Why: a tab from before a deploy keeps its old code, and a format change makes it show messages it
cannot decrypt (K-1). A check-in is the only channel to a tab (D-004), so the header rides on it.

Cost: a deploy that changes the page reloads every open tab once, which drops scroll positions and
any open dialog. Every deploy costs each tab one fetch of the page. A tab with a failed message or
an undismissed alert keeps the old build until they are dealt with. A self-hosted server that
restarts with the same build does not reload tabs.

### D-041: Only main deploys from Git

Accepted 2026-11-01 in #7.

`git.deploymentEnabled` in `vercel.json` turns off automatic deployments for every branch but
`main`. A branch without `vercel.json`, such as one that holds only screenshots, escapes that rule,
because Vercel reads it from the pushed commit. So the project's settings on Vercel set the Ignored
Build Step to `[ "$VERCEL_ENV" != production ]`, which skips every build but production. The
`ignoreCommand` in `vercel.json` overrides it, so it runs only on such a branch (#83).

Why: Vercel for GitHub otherwise builds a preview for every push and a production deployment for
every merge, from Hobby build minutes and the daily deployment cap. A preview of this app is not
useful. The GitHub connector cannot connect on a preview URL, because the OAuth App has one callback
URL (D-032). The server runs pending migrations at start (D-010), so a preview that shares the
production database would apply a branch's new migration before the pull request merges. Changes
people see are checked locally instead (D-037).

Cost: no preview URL on pull requests. Trying a branch on a real phone, where push needs HTTPS,
takes a deployment by hand with `vercel deploy`, which the setting does not stop.

### D-068: Only failed sign-ins use up the limit for an address

Accepted 2026-11-03 in #52.

Register, login, the upgrade, the key backup and setting keys share one limit per IP address: 20
attempts in a fixed window of 15 minutes. Each attempt counts before it runs. When it succeeds, the
route gives the hit back with `returnRateLimit` in `server/db.ts`, before it answers, not on the
response's `finish` event, because a Vercel function may stop once its answer is sent. Only
failures stay counted: a wrong password, an unknown user, a wrong invite code, a taken username, or
a request that does not parse. A class that signs up together behind one campus address does not
lock itself out (K-14).

Why: counting first keeps the check atomic. Counting only after a failure would let a burst of
parallel guesses all pass before any was recorded. Raising the limit for everyone would give
guessers more tries too.

Cost: a full window still blocks everyone behind that address, the right password included. One
student who types 20 wrong passwords locks out the rest of the class for up to 15 minutes. The
first sign-in of an account from before encryption counts as a failure, because it answers
"upgrade required".

### D-080: A browser that has had an account cannot sign up for another

Accepted 2026-11-03 in #71.

Each device makes one account, and the browser counts as the device. Signing up, signing in and
signing out set the `webchat_device` cookie. It holds only `1` and lasts 400 days, the most
browsers allow, and each sign-in starts the 400 days again. Sign-up refuses a browser that sends it,
with "This device already has a WebChat account." Signing in to another account on the same device
still works.

Why: the owner wants one device, one account. A web page cannot read a hardware id. A limit per IP
address would stop a class that signs up together behind one campus address, which D-068 protects.
A browser fingerprint would make phones of the same model look like one device. A cookie without an
id cannot tie a device to an account.

Cost: it is easy to get around. A private window, another browser, or clearing the site's data
allows one more account. Someone who signs in on a friend's phone or a shared computer stops that
browser from signing up for 400 days. Testing two accounts still needs two hosts, such as
`alice.localhost` and `bob.localhost`.

### D-088: A deleted account leaves every chat and keeps its row

Accepted 2026-11-05 in #94 (R-028).

`DELETE /api/auth/account` deletes the signed-in account. The server treats it as leaving every
group and channel at once (D-044, D-045): the person's member rows and wrapped keys go, and each
chat needs a new key before anyone sends again. It refuses, with `owner`, while the person owns a
project or group with other people in it, so they hand it over or delete it first. Groups and
projects with nobody else in them are deleted, and so are the person's direct chats. Sessions,
push subscriptions, Bark and GitHub links go too. The `users` row stays, with `deleted_at` set, the
display name "Deleted account", the username `deleted-<id>`, an empty password hash and no keys. A
deleted id counts as "Person not found" wherever someone would key a chat for it. The answer clears
the session cookie and the device cookie of D-080.

Why: `messages.sender_id`, docs and revisions point at the row, and other members keep their copy
of what the person wrote, so the row has to stay for those messages to keep a sender. Leaving is
the one path that already rotates keys the way rule 5 demands, so deletion reuses it instead of
adding a second. The username is freed because a name is the person's, not the server's; a hyphen
is not allowed in usernames, so nobody can sign up as the stand-in. The device cookie is cleared
because the device has no account any more, which is what D-080 counts.

Cost: a direct chat is deleted for the other person too, since a direct chat with one member has
nobody to name it. Someone can delete an account and sign up again on the same device, which is
one way around D-080's one account per device; the invite code still gates it. The page shows
"Deleted account" on old messages, and pickers hide those rows, but their ids stay in the users list
every page loads. Deleting asks for a confirm, not the password.

## Data and platform

### D-010: Migrations only grow at the end

Accepted 2026-11-01 in 10ba6d8.

`SCHEMA` in `server/db.ts` creates the original tables. Every later change is an entry at the end of
`MIGRATIONS`. Each entry runs once, in order, in a transaction that holds an advisory lock, because
several serverless instances can start at once. `webchat.meta` records how many have run. So far:
1 is end-to-end encryption, 2 is the GitHub connector, 3 is projects with replies and reactions, 4
is group owners, 5 is key rotation, leaving and handing over, 6 is sharing new pull requests into
projects, and 7 pulls back delivered pointers that went past a chat's newest event (D-022).
When two branches add migrations, the one that reaches main first keeps its number, because a
database that already ran that number would skip the other.

Cost: a mistake in a migration on main is fixed with a new migration, never by editing the old one.

### D-011: Limits live in one place

Accepted 2026-11-01 in 74d53ff.

`LIMITS` in `shared/types.ts` holds the sizes that the server enforces and the page respects: 4,000
characters per message, 160 per quote, 24,000 per ciphertext, the lengths of names, 50 messages per
history page, and 20 people added to a project or group at once. Express accepts JSON bodies of up
to 256 KB (`server/app.ts`). That caps batch requests: adding 20 people to a project sends every
channel's key wrapped for each of them. Removing someone sends a new key for every channel, wrapped
for each person who stays, with the old key inside (D-044). A copy takes about 110 bytes, so 256 KB
holds about 2,300 copies, for example 40 people with 58 channels. A body over the limit, or one
that is not JSON, gets a JSON error the page can show.

Cost: raising a limit can need a larger body limit too. Check both.

### D-012: Query strings through the WHATWG URL API

Accepted 2026-11-01 in d4083df.

Reading `req.query` makes Express call Node's `url.parse()`, and Vercel then logs its deprecation
warning (DEP0169). Routes read query strings with the WHATWG URL API instead. The history route does
it inline, and the GitHub routes use the `queryOf` helper in `server/api.ts`.

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

Accepted 2026-11-02 in #21.

Safari on iPhone keeps the page at full height when the on-screen keyboard opens, and scrolls the
page up until the focused field shows, which would push the chat's header off the top.
`client/src/viewport.ts` sets the CSS variable `--visible-height` from the visual viewport, the
layout takes that height, and the page stays at the top. Dialogs centre in the same area and scroll
inside. This runs only while the chat layout shows, and it leaves a pinch-zoomed page alone.
Resetting Safari's animated scroll midway makes the page drop (K-25). So on a touch screen with the
keyboard closed, a field that takes the focus is moved far above the screen, and Safari finds
nothing to scroll to. It comes back when the visual viewport resizes, or after 400ms. Opening a
chat does not focus the message box. Every hover style sits behind `@media (hover: hover)`, since a
touch screen keeps `:hover` on the last thing tapped.

Cost: the field disappears for a moment as the keyboard opens. Whether Safari skips its scroll
depends on when it reads the field's position. Checked in Chromium, not yet on an iPhone.

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

Accepted 2026-11-01 in 10ba6d8.

Each chat has a random AES-256-GCM key. The member who creates it wraps a copy for every member with
a key from ECDH between the two of them, so a wrapped copy proves who made it. The page accepts a
copy only when the person who wrapped it is a member of the chat. The server checks that a new key
comes wrapped exactly once for every member. When someone joins, the member adding them wraps their
own copy for the newcomer (D-026, D-043). When someone leaves or is removed, the chat gets a new
key, wrapped by a member who stays (D-044).

Cost: a page opens a copy wrapped by someone who left only to make the chat's next key, never to
encrypt with it (D-044).

### D-016: Encrypt, then sign everything the server could change

Accepted 2026-11-01 in 10ba6d8.

A message is encrypted with the chat key, then signed with the sender's ECDSA key. The signature
covers the ciphertext and a header with the chat, the key id, the sender, the urgent flag, the
client id, and the kind for kinds other than "message". The page rejects a message whose header the
server changed and shows it as "could not be decrypted".

The kind is in the header only for new kinds, so messages signed before kinds existed still verify.
A new field that the server stores and the page acts on must join the header the same way.

The page keeps the text of messages it has decrypted, with the signed fields and the signature they
were checked against. It checks a message again when the server sends it with any of them changed.

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
60-digit security code: matching codes mean nobody swapped keys between them. Until the check, the
page also trusts nothing signed or wrapped with the changed keys. It refuses to open a new chat key
that person wrapped, so it never sends under a key the server could know. It shows their new
messages as unreadable, and the service worker shows their pushes without text. A chat key stored
before the change still works. The pins stay on the device when someone signs out or in, so a swap
made while nobody was signed in still shows a warning. They hold only fingerprints of other people's
public keys.

Cost: a device trusts the first keys it sees for a person without proof. After someone's keys change
for a real reason, their new messages stay unreadable until the user checks the code. The page keeps
what failed to open, and opens it again after the check, without a reload (K-26).

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

Accepted 2026-11-01 in 10ba6d8.

WebChat accepts these limits and lists them in the README. An operator who changes the app the page
runs could read messages. The server sees metadata: who talks to whom and when, group, project and
channel names, who is in which project or group, who added them, who owns each, who left, when a
chat got a new key, display names, whether a message is urgent, that someone reacted, and its size
band (D-059). It sees pull request titles and repository names (D-033), which docs a project has,
their section counts, editors, times and size bands, and who is editing now; it could show an older
section revision as the newest (D-081). It sees the repositories a project links, whose cards it
writes in plain text and could fake (D-050), and the one an agent's session is open in (D-093). It
supplies the member list a new channel's key, or a key after someone leaves, is wrapped for; the New
channel dialog shows it (D-044). People who leave keep the keys they had (D-044). Someone who writes
to the database can add unencrypted messages under any member's name, which show as "Not encrypted"
and never alert (D-019).

Cost: a feature that shows the server something new must add it to this list and to the README.

### D-044: A new key when someone leaves or is removed

Accepted 2026-11-01 in #13. Replaces the part of D-039 that kept keys the same.

When someone leaves or is removed, the chat gets a new key they never get. The browser that makes it
wraps it for everyone who stays and encrypts the old key with the new one. The server keeps these
links in `key_links`, and `ConversationDTO.keyLinks` hands them to members, so the whole history
stays readable, also for someone added later (D-026, D-043). A page never encrypts with a replaced
key. On removal, the owner's browser makes the new key of every channel, or of the group, in the
removing request. The server checks under the project's or group's lock that each new key names the
current one in its link and is wrapped for exactly the people who stay. On leaving, the server sets
`needs_new_key` on each chat left and refuses messages there with `409 needs_new_key`. The first
member's browser that checks in or sends makes the key with `PUT /conversations/:id/key`. The others
get `409 stale_key` and take it. The leaver may have wrapped a member's copy of the old key. It is
opened without D-015's membership check, since it only goes inside the new key and never encrypts
again.

Cost: anyone with the current key reads the whole history. After someone leaves, nobody can send in
that chat until a member's browser makes the key, which waits for a member to be online or for a
security code check (D-018). Until a page opens the key, a push shows "New encrypted message"
(D-017).

## Messaging

### D-021: The sync fingerprint is the change detector

Accepted 2026-11-01 in 74d53ff.

`db.stamp` builds one string per user from a single query. It covers the sum of the newest event
ids in their chats, the read and delivered pointers, how many chats they are in, the sum of the
times their members joined those chats, how many chats have keys, the sum of the times their keys
were replaced (D-044), a hash of who owns each of their projects and groups (D-045), how many people
there are and how many have keys, who is online, which agents are busy (R-027), which accounts are
agents (K-41), a hash of each doc's version, and a hash of the doc locks held now (D-081). Owners
go in as a hash, not a sum, so two handovers at once cannot cancel out. A check-in whose stamp
matches answers "unchanged" without loading anything else.

Cost: any new state that pages must see has to change this string, or pages miss it until
something else changes.

### D-022: Receipts are per-member pointers

Accepted 2026-11-01 in 74d53ff.

Each member of a chat has a delivered pointer and a read pointer. Messages with an id at or below a
pointer count as delivered or read. Check-ins move the delivered pointer, and opening a chat moves
the read pointer. The service worker reports delivery when a push arrives, so the sender sees
"delivered" even while every tab of the recipient is closed.

A pointer never moves past the chat's newest event, whatever id a client sends. A pointer near the
top of the INTEGER range would overflow the sum in the sync fingerprint (D-021) and stop every
member of the chat from loading. The fingerprint adds pointers as BIGINT.

### D-023: Urgent messages ring until acknowledged

Accepted 2026-11-01 in 74d53ff.

The sender marks a message urgent with the bell next to the message box, and the urgent flag is
signed (D-016). The recipient's open tab shows a full-screen alert and rings until they dismiss it,
even with message sounds off. The push waits up to 3 days for an offline device instead of 1, and
the notification stays until the user acts on it. Reactions cannot be urgent (D-016, D-030).

D-079 makes it ring again every 15 seconds while the recipient looks away, until they read it.

### D-047: Safari gets no silent pushes

Accepted 2026-11-01 after a review of main.

WebKit, which runs Safari and every web app on iPhone and iPad, revokes a push subscription after a
few pushes that show no notification. The service worker shows nothing for a push that arrives
while the user looks at the app (D-007). So the server sends no push to a Safari endpoint while it
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
every later check-in would answer "unchanged" without it. So the server compares the newest message
id with the answer's cursor. When messages are missing, it answers `more: true` with an empty
fingerprint, and the page checks in again at once, up to 10 rounds in a row. `GET /api/bootstrap`
reads the fingerprint before anything else, so a change during the load makes the first check-in
answer "changed".

Cost: catching up after a long sleep takes several full check-ins in a row.

### D-049: Only messages new to the user alert

Accepted 2026-11-01 after a review of main.

A check-in re-sends the last 15 seconds of messages, and a person added to a project gets its
history (D-026). A message alerts only when its id is above both the cursor the page loaded with
and the user's own read pointer in that chat, and it is encrypted (D-019). So a reload does not
replay recent alerts, and joining a project does not alert for its old messages.

Cost: a message that commits more than a moment after a newer one while the page loads shows up
without an alert.

D-078 makes an exception: an unread urgent message from the last 3 days alerts when a page opens.

### D-051: Drafts and unsent messages stay on the device

Accepted 2026-11-02 in #19.

What someone types in a chat's message box, and every message the server has not confirmed, stay in
the device's IndexedDB next to the account's keys. A draft comes back when its chat opens again. A
message that was sending or failed comes back as "Not sent", with a toast that names the chat,
unless the chat's history shows the server has it. The page never sends it again by itself. "Tap to
retry" keeps the client id (D-061), and Remove drops the message. A tab with a message still
sending asks before it closes. Signing out removes them with the keys. A tab holds a Web Lock while
it keeps unsent messages, and a tab that opens takes over only those of tabs that hold no lock.

Cost: drafts and unsent messages sit on the device unencrypted until sent or signed out. A browser
without Web Locks, such as Safari before 15.4, can show one unsent message in two tabs. A message
that reached the server as its tab closed shows as not sent if newer messages push it off the
chat's first page, until a retry brings back the stored copy (D-061).

### D-056: A 2xx answer whose body does not parse is a failed request

Accepted 2026-11-02 in #27.

Every route answers with JSON, or with 204 and no body. `request` in `client/src/api.ts` treats a
2xx answer whose body fails to parse as a failed request and throws an `ApiError` that carries the
status. A parse failure treated as success would give the sync loop a cursor of NaN, which no later
`Math.max` repairs, so every check-in would ask from 0 and a user with more than 500 messages would
stop getting new ones (K-7). On a failed status the body still falls back to `{}`, so the default
error message stands.

Cost: a route that answers 2xx without a JSON body must use 204, or every call to it fails. A send
whose answer breaks off shows as not sent, like one whose connection dropped, although the server
stored it. A retry brings back the stored copy (D-061).

### D-061: A sender's client id names one message per chat

Accepted 2026-11-03 in #35.

Every send carries a client id the page made, signed into the envelope (D-016). A unique index on
(chat, sender, client id) in `webchat.messages` makes it name one message per chat. When a send
repeats a client id its sender used in that chat before, `db.insertMessage` stores nothing and
returns the stored message, the route answers 200 instead of 201, and no push goes out.
`retryMessage` in `client/src/chat.ts` keeps the client id of the message it sends again.

Why: a send whose answer was lost, to a dropped connection or a 2xx that broke off (D-056), shows
as not sent although the server stored it. A retry under a new client id would store a second copy,
and an urgent one would alert everyone twice (K-9).

Cost: migration 10 fails on a database that already holds two messages with the same chat, sender
and client id, and the server then stops at start. The page's retries never made such rows; only
two tabs sending the same stored message in a browser without Web Locks could (D-051). A repeat
answers with the first copy's envelope, not the one just sent, which the page never needs to read.

### D-075: A chat's messages are sent one at a time

Accepted 2026-11-03 in #53.

`sendContent` in `client/src/chat.ts` encrypts and posts a message only once the chat's previous
send has settled, through `keyedQueue` in `client/src/queue.ts`. A message shows as sending, and
stays on the device (D-051), from the moment it is written, while it waits its turn. A send that
fails does not hold up the ones behind it: they go out, and the failed one shows "Not sent". A
retry joins the back of its chat's queue. Chats do not wait for each other.

Why: the server numbers messages in the order they arrive. Sends that each ran on their own could
be stored out of order, and a reload kept that order (K-24).

Cost: a burst of messages goes out one round trip at a time, so the last one arrives later. A
request that never ends holds up its chat's later sends until the request gives up (D-077). A
retried message is stored after the ones sent while it waited. The order holds within one tab only:
two tabs that send to one chat at once still race.

### D-072: An expired session ends the browser's push subscription

Accepted 2026-11-03 in #47.

When a check-in or the page's first load answers 401, the page ends this browser's push
subscription, the way "Turn off on this device" does. Without a session the server cannot be asked
to drop its row, so the row stays until the next push to it. The push service answers 410 Gone, and
the server deletes the row. "Sign out" still drops the row on the server first and leaves the
browser subscribed.

Why: otherwise the server keeps pushing the old account's messages to that browser, and a push
names the sender and the chat in its title. Whoever used the browser next would see them (K-18).

Cost: the next sign-in in that browser subscribes again with a new endpoint, outside a click. A
browser that allows that only from a click needs notifications turned on again in the bell dialog.
Each dead row costs one refused push before it is deleted.

### D-069: A check-in answer older than a change on the page is dropped

Accepted 2026-11-03 in #44.

`client/src/store.ts` counts the changes the page makes to its chats and projects ahead of the
server: a chat or project it adds, changes, leaves or deletes. A check-in notes the count when its
request goes out. When the count moved before the answer is applied, `applySync` applies nothing,
and the page checks in again at once with the same stamp and cursor. `reloadAll` fetches again the
same way, because its callers go on with what it loads.

Why: the server builds an answer from the chats as they were when the request arrived. A late
answer can close a chat the page just opened ("It was deleted, or you were removed", K-15), bring
back a chat the page just left or deleted, or restore a project's old member list.

Cost: every change on the page that overlaps a check-in costs one more check-in. A change that
reaches the store some other way must go through the counted actions, or a late answer undoes it
until the next check-in.

### D-078: A page that opens alerts for the urgent messages it missed

Accepted 2026-11-03 in #65.

`GET /api/bootstrap` lists each chat's newest urgent message from someone else that the user has
not read, sent in the last 3 days. The page treats each one like a message that has just arrived,
so the full-screen alert rings until Open chat or Dismiss. It alerts only when the signature checks
out, so the server cannot make a message urgent (D-016). Dismiss keeps the message's id in the
device's IndexedDB, and pages on that device do not alert for it again. Open chat marks the chat
read, which ends the alert on every device. This is an exception to D-049. The 3 days match how
long an urgent push waits for an offline device (K-21).

Cost: browsers hold sound until the first tap or key, so the alert at open is often silent. When
the push reached the device, its notification and the page's alert both show. Each other device
alerts once. Only a chat's newest unread urgent message alerts at open.

### D-077: A request gives up when its answer has not started after a minute

Accepted 2026-11-03 in #61.

`request` in `client/src/api.ts` aborts a request whose answer has not started 60 seconds after it
went out. It uses an `AbortController` and a timer, because `AbortSignal.timeout` needs Safari 16
and the build supports iOS 15.4 (D-052). A request that times out fails like one whose connection
dropped: a send shows "Not sent", and the next one in its chat goes out (D-075). "Tap to retry"
keeps the client id, so a message the server stored after all is not stored twice (D-061). The
timer stops once the answer starts, so reading the body is not timed. Vercel ends a function after
30 seconds, and the other 30 leave room for a slow upload. Timing only the start keeps a large
check-in answer from being cut off on a slow connection (K-32).

Cost: a send on a dead connection shows "Not sent" only after a minute. An answer that stops
partway through its body still hangs. A request still uploading after a minute fails, although the
server might have taken it.

### D-079: An unread urgent message rings again every 15 seconds

Accepted 2026-11-03 in #69.

The server sends an urgent message's push again every 15 seconds to each member who has not read
the chat and is not looking at the app, until they read it on any device or it is 3 days old. Each
push repeats the first, and through Bark the phone rings for 30 seconds each time (D-054). A Bark
alert for an urgent message is critical, so it rings through silent mode. The service worker closes
the last notification first, because only Chromium sounds again for the same tag. Only a chat's
newest unread urgent message rings, and a page that is looking rings on its own (D-023). Pushes
carry a `Topic` header from the hashed tag. A self-hosted server rings on a timer. On Vercel, the
Supabase Cron job `webchat-urgent-ring` calls `GET /api/urgent/ring` every 15 seconds with the
GitHub poll's secret (D-057), only while an unread urgent message exists (R-019).

Cost: a phone rings every 15 seconds until opened, at night too. Silent mode and Do Not Disturb
mute a Web Push, and Bark rings through them only where critical alerts are allowed. Vercel runs up
to 5,760 calls a day. Without pg_cron and pg_net, an urgent message rings once.

## Projects and channels

### D-054: iPhones without Web Push get alerts through the Bark app

Accepted 2026-11-02 in #23.

iOS 15 phones never get Web Push, and an app of our own needs the paid Apple Developer Program. So
WebChat alerts them through Bark, a free open-source app whose author publishes the APNs key its
pushes are signed with. The server stands in for Bark's server: the bell dialog makes a URL with a
secret token, and the person types it into Bark. Whenever a Web Push would go to the person's other
devices (D-007), the server also sends an APNs push signed with Bark's key: chat name, sender name,
urgency and unread count, never the text (D-014). With encryption on, a second key typed into Bark
makes it AES-256-GCM ciphertext. One provider token signs pushes for an hour, shared through the
database, as Apple refuses refreshes under 20 minutes.

Cost: depends on Bark and a key its author could withdraw; it goes in `BARK_APNS_KEY`, never the
repository. Apple sees push timing and collapse id, and without encryption the names; Bark sees
the alert (README lists this). No delivered tick until WebChat opens. Link state is not in the sync
fingerprint (D-021).

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
same way (D-043).

Cost: only a member whose browser can open every channel key can add people. The server records who
added whom.

### D-027: Slack-style channel names

Accepted 2026-11-01 in #2.

Channel names use lowercase letters and digits in any script, joined by single hyphens, up to 40
characters, and are unique within their project. The page turns what people type into that form,
so "Slides & Design" becomes `slides-design`. Every project starts with `#general`.

### D-065: One channel name rule for the page and the server

Accepted 2026-11-03 in #51.

`toChannelName` and `isChannelName` in `shared/types.ts` hold the rule of D-027 for both sides. The
New channel dialog makes names with the first, and the server checks them with the second, so no
name the dialog shows gets a 400 (K-11). The page applies NFKC first, so a capital with no
lowercase form, such as ℂ, becomes a plain one. It cuts the name to the limit before it trims
hyphens, and it counts UTF-16 units as the server does.

Cost: NFKC also folds other look-alikes, such as full-width letters and ligatures, so a few typed
names change more than people expect. The dialog shows the result before it creates the channel.

### D-039: Owners remove people and delete, before key rotation

Partly superseded by D-044 and D-045: removal gives each chat a new key, and people can leave.
Accepted 2026-11-01 in #4. Replaces D-028.

The person who made a project or group is its owner. Only the owner removes people or deletes it,
with every channel and message. `conversations.created_by` (migration 4) names a group's owner: who
wrapped its key copies, or for a pre-encryption group who set its key; with no key yet, no owner,
and any member manages it. A page accepts a key copy only from a current member (D-015), so removal
makes the owner's browser wrap every key in the project or group again for exactly the people who
stay. The server checks this under the project's or group's lock and answers `409 stale_project` or
`409 stale_group` when the page's view is stale; the page reloads and retries once (D-025). Being
removed sends no notification; a page with the chat open closes it and says why.

Cost: removed people keep the keys they had. Only a browser that can open every key in the project
or group can remove someone, and the request carries every key wrapped for those who stay (D-011).

### D-043: Any group member adds people, and they read the history

Accepted 2026-11-01 in #10. It answers the open question of roadmap item R-003.

Groups take new members as projects do (D-026). Any member adds up to 20 people at once with the
Add people button; that member's browser wraps its own copy of the group's key for each newcomer.
Each key holds the one it replaced (D-044), so newcomers read all history, and their read pointers
start at the newest message. Being added sends a push (D-031). Under the group's lock the server
checks that the copies cover exactly the people added, that the group still has the key they were
made from and that the adder is still a member, else `409 stale_group` and one retry (D-025).
Adding to a project checks the adder's membership under its lock too. A pre-encryption group with
no key takes members without one; its first message keys it for everyone (D-019). Pages alert only
for messages after the user's read pointer, so history does not ring. Why: hiding history needs a
new key per join (R-002).

Cost: any member can expose all history; only the owner removes. Others see a newcomer only in the
member list (R-017). Who added whom shows only from who wrapped each copy, until a new key (D-044).

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

### D-081: Docs live in a project, keyed by #general, with one editor per section

Accepted 2026-11-04 in #73.

A project's shared docs (R-020) belong to its #general (D-024), whose key encrypts every doc, so
D-026 and D-044 cover docs. The server takes a doc only in a channel. A doc is a title and sections
stored as revisions, sealed under their own header `webchat/doc/v1`, which binds chat, key id,
author, doc and section, so a revision never passes as a message and cannot move. The browser makes
the doc's id. A section's place is a number inside its content; a deleted section is a revision
marked removed. One person edits a section at a time under a lock in `doc_locks`, kept by the
editing tab's check-ins (every minute in the background) and gone 2 minutes after the last. A save
needs the lock; one editing session replaces one revision. Doc versions and held locks join the sync
fingerprint (D-021). Why: no merge code, dependency or open connection (D-004, Q-1).

Cost: no two editors in a section; a closed tab holds its lock up to 2 minutes; each save reloads
open copies. The server sees who edits which section and when, and could show an older revision as
newest (D-020). Docs are Markdown only, exported only as PDF through print.

### D-082: The project board is two docs whose sections are cards

Accepted 2026-11-04 in #75.

A project's board (R-021) is a view over two docs: Decisions, and Roadmap for ideas and issues. A
card is a section of that doc, with its lock and history (D-081). A `board` field inside the sealed
content of the doc's title marks them, so the server does not know a board from a doc, and the
sidebar leaves them out of Docs. The browser makes them when someone first adds a card. A card's
number, title and status come from its first two lines, `### D-3: Title` and `Status: Accepted
2026-11-04.`, the format of `docs/decisions.md` and `docs/roadmap.md`. "Copy as Markdown" joins a
column's cards into that file. Why: needs no migration, route, key code or fingerprint change, and
a team pastes a column into its repository for its agents to read.

Cost: the browser numbers a new card from the cards it has, so two tabs can take one number; the
board warns and someone renumbers (D-063). Two tabs making the board doc at once make two; the
board shows the oldest and the other appears in Docs for deletion. Status is wording, not a field,
so an unknown status sorts with the open items.

### D-085: An agent runtime is a member account, and its daemon a headless client

Accepted 2026-11-05 in #85.

A coding agent a student runs for a project (R-027) joins as an account of its own, made by pairing
with its owner since #100 (D-093). Its daemon, a headless client in `agent/`, uses the page's `/api`
routes and keeps its keys, login key, session cookie and pins in `~/.webchat/<name>/account.json`,
or the Claude Code plugin's data folder (D-092). It checks in with `POST /api/sync` every 15
seconds, opens keys and messages, sends sealed messages and edits doc sections under the section
lock, with code ported from `client/src/e2ee/keyring.ts` and `client/src/chat.ts` on
`shared/e2ee.ts`. Check-ins say whether it runs a card; that flag is in the sync fingerprint
(D-021), so the menu offers only idle agents. Why: rule 5 gives keys only to members, and the
owner's keys would expose their direct messages.

Cost: one account per runtime. Private keys sit in a file in the clear, readable only by its owner,
since Node has no unexportable key store (README lists this). Two daemons must not share an account
file. The daemon never makes keys, so after a removal (D-044) it waits for a member's browser. Key
logic is ported, not shared, until K-40.

### D-086: A run is a request message and the reports that name it

Accepted 2026-11-05 in #86.

Handing a card to an agent (R-027) sends an ordinary message of kind "message" into #general. Its
sealed content carries a `run` field, as a pull request carries `pull` (D-042): the card's id and
title, its doc and section, and the agent's account. It names the card, not its text: the daemon
reads the card from the board when it claims, with its member key. It runs one request at a time
(D-089 says whose). It answers with messages whose `run` field names the request's message id and
says claimed, done or failed, with a note, a branch and a pull request if any; the text says the
same. A page folds reports into the request's card and shows the latest, only from the agent the
request names. An older page shows the texts. Why: the signature proves who asked (D-016), and
separate report messages stay immutable and signed by their author.

Cost: each report is an unread message that alerts, so keep them sparse. The request's id is the
server's, so a changed server could attach a report to another request, but could forge neither.

### D-087: A run is a worktree, a brief and a headless coding agent

Accepted 2026-11-05 in #87.

The daemon runs a card in the project's repository on its owner's machine. `config.json` next to the
account file maps each project name to a local checkout and picks the agent. A run fetches `origin`,
adds a git worktree on a branch named after the card, such as `agent/k-12-bad-keys`, under the
account's `runs` folder, and writes a brief outside the repository: the card's Markdown, the board's
Decisions column and how to finish (small commits, a push, `gh pr create --draft`, never a push to
main). It runs the agent headless there until its final word. The run fails when no commits are left
or after 2 hours of silence; else it reports the branch, the pull request `gh` finds and the closing
line. A rerun gets a numbered branch. Adapters: `claude -p ... --output-format stream-json
--permission-mode acceptEdits` with the shell limited to `git`, `gh pr` and npm scripts; `codex exec
--json`, approvals off, network open; `hermes chat --oneshot --quiet --yolo --format stream-json`.

Cost: finished worktrees and briefs stay on disk. The tool list is no sandbox: it runs with the
owner's git and GitHub credentials, so D-089 limits who may send runs. The Codex and Hermes
adapters were wired from their documentation and not run end to end.

### D-089: An agent runs the cards its owner hands it

Proposed 2026-11-05 in #95.

An agent account belongs to the owner who approved its pairing (D-093, since #100). The server keeps
the owner on the account, and the sync fingerprint (D-021) carries it. A card's play button lists
only the viewer's own agents, and none while someone holds the card's lock. The agent keeps the
owner's id and pins the keys the pairing proved. It runs a request only when the owner sent it,
proved by signature against the pins. The owner's page signs the send time into `run`; the daemon
refuses a time over 10 minutes from its own clock, or none. Others' requests fail with a report. The
brief holds the card as on the board and every decision. The run card in #general is the run's
status. Why: a username allow list trusts the server (K-42, K-45).

Cost: the owner vouches for card and decisions by clicking; a teammate's text runs with the owner's
credentials. The `agent` column of migration 13 is unused. A teammate's agent is R-029.

### D-092: An agent can run as a Claude Code plugin whose server rings a doorbell

Accepted 2026-11-05 in #100, proposed in #99.

An agent can run inside Claude Code as the plugin in `plugin/` (R-030). Its MCP server,
`agent/plugin.ts`, is the trusted part: it keeps the agent's keys in the plugin's data folder, uses
the owner's `gh` login, checks requests as D-089 says, adds a worktree under `.claude/worktrees`
and pushes only that `agent/*` branch, never forced. A monitor tails a file the server writes, with
ids only; `start_run` refuses an id the server did not file. The model works sandboxed with no
credentials. A guard hook keeps file tools from the secrets, and in the worktree with no web during
a run. Runs wait until the sandbox is on and `denyRead` covers the secrets. A draft gets three
rounds of fixes for failed CI, conflicts and reviews by writers. Why: one install, and channels
need a flag on every start.

Cost: the session must stay open, and one per machine watches. `experimental.monitors` may change.
A teammate's card runs with the owner's credentials; the owner reviews the draft.

### D-093: An agent pairs through a one-time code, and runs only in the repository its owner signed

Accepted 2026-11-05 in #100. The code carries the address since #101 (R-031).

The owner's page shows 128 random bits as a code, after its own address as `<address>#<code>`, so
the agent needs no address setting and a browser never sends the code. The agent sends new keys and
a random login key with an HMAC of the keys under the code, filed under the code's SHA-256. The page
checks the HMAC; on approval the server makes the owner's agent account, with a random username and
no key backup. The approval carries an HMAC of the owner's id and keys and the agent's keys, which
the agent checks and pins. A pairing works once and lapses after 10 minutes. A plugin's check-ins
name the GitHub repository its session is open in; the page signs the one its menu showed into the
request, and the plugin runs it only there. An agent remembers each request's signed client id while
it could run, across restarts (K-47). Why: no invite code, password or security code to compare.

Cost: the server sees the repository an agent's session is in. Deleting an account deletes its
agents. A new code makes a new account, and the old one stays, asleep.

### D-094: Each repository's Claude Code session takes that repository's runs

Accepted 2026-11-05 in #104.

An agent's Claude Code sessions each take the runs of the repository they are open in (R-032). A
session checks in with its repository, which `agent_repos` keeps with its own busy flag and last
check-in, and the play menu lists one entry per repository. The plugin keeps a folder per repository
in its data folder: a copy of the account, a lock, a doorbell and the watched pull requests, so no
two sessions write one file. The monitor asks the plugin for its repository's doorbell, so a run
wakes only that session, and a session says nothing on another repository's request. A second
session in one repository takes over when the first closes. A run nobody starts fails after 30
minutes. Why: students keep several repositories open, and the first session to start took all.

Cost: a request for a repository with no open session waits until the owner cancels it. The
`agent_repo` column of migration 17 is unused. A repository unseen for 30 days leaves the menu.

### D-095: A Claude Code session takes runs only while its own monitor hears the doorbell

Accepted 2026-11-05 in #108.

The plugin's monitor passes its session's process id, `$PPID`, to the doorbell command. That writes
a mark in the repository's `monitors/` folder holding the session's start time from `ps`. The MCP
server, a child of the same session, takes the repository's lock only once it finds its session's
mark (K-49). Why: the Claude desktop app starts no plugin monitor, and a session updated in place
keeps the monitor it started with, which may tail an old doorbell. Both took the lock, so their runs
rang where nobody heard and failed after 30 minutes, while a terminal session there waited.

Cost: Claude Code must start the monitor's shell and the MCP server as direct children of the
session. A mark stays after its session ends; the start time keeps it from counting.

### D-096: The owner deletes a channel, but never #general

Accepted 2026-11-05 in #110 (R-034).

A project's owner deletes a channel for everyone from the "⋮" at the end of its row, as with a doc.
Its messages, keys and repository links go with it, as when a group is deleted (D-039). #general
stays: its key opens the docs and the board (D-081), and pages take the project's oldest channel
for it. The server deletes under the project's lock, so a change that must bring every channel's
key (D-025, D-044) sees the channel or answers `409 stale_project`. Other pages drop it at their
next check-in, with a note if it was open, and nobody gets a push (D-039). Why: teams make channels
for short tasks, and only deleting the whole project took one away.

Cost: a deleted channel cannot come back. A repository linked to it stops posting cards until the
owner links it again. Whoever made a channel cannot delete it unless they own the project.

### D-097: An agent works in conversations with its owner, each run by a background Claude

Proposed 2026-11-05 in #112 (R-035).

The owner talks with an agent in the Agents pane, in their direct chat. A prompt is an encrypted
message whose signed field names the repository and, for a card, a hash of the brief the owner saw.
The plugin answers each conversation with a background `claude -p` under a settings file of its
own: a sandbox that blocks its keys and `gh`'s folder, the webchat tools allowed, web search on, and
the shell limited to the package registry; a reply resumes that session. A card's conversation
works in a worktree and opens a draft; a prompt may only answer. A fix round from another's review
waits for the owner, and a card the agent drafts reaches the board only when the owner adds it, so
no agent writes a card that then runs unread. Why: with no doorbell or monitor the desktop app
works, the owner edits no settings, `gh` stays usable in the owner's sessions, and the owner can
prompt from a phone.

Cost: a turn waits up to 15 seconds for a check-in, and nobody watches a run live. A page Claude
reads could make it leak repository code. It replaces D-092's doorbell and D-095's monitor mark.

## Replies and reactions

### D-029: Replies carry a quote inside the envelope

Accepted 2026-11-01 in #2.

A reply's encrypted content holds the id and sender of the message it answers and up to 160
characters of its text, so the quote shows even when the original is not loaded. When the original
is loaded, the page shows the original, whose signature it checked, instead of the copy the replier
wrote. Tapping a quote scrolls to the original and highlights it. The ciphertext limit is 24,000
characters, which leaves room for the quote.

Cost: the quote of a message that is not loaded is only as honest as the person who replied.

### D-030: Reactions are messages of their own kind

Accepted 2026-11-01 in #2.

A reaction is a row in `messages` with the kind `reaction`. Its envelope holds the emoji and the
message it is for, so the server sees only that someone reacted. Reusing messages gives reactions
the same sync, history paging, encryption and signatures, without a new table. The newest reaction
from a person to a message wins, and an empty emoji takes it back. The server refuses an urgent
reaction instead of changing it (D-016). The page offers WhatsApp's six quick emoji.

`conversations.last_event_id` follows every row, so sync notices reactions, while
`last_message_id` follows only messages. So reactions do not count as unread, do not move a chat up
the list and do not replace its preview. They notify nobody: their push only wakes a tab the
recipient is looking at.

Cost: reactions count toward the 50 rows of a history page. So the page pages from the oldest row it
fetched, not the oldest message it shows, and keeps going while pages bring only reactions. An old
tab shows reactions as messages it cannot decrypt until it reloads (roadmap K-1).

### D-070: The service worker never shows a reaction

Accepted 2026-11-03 in #45.

A reaction's push only wakes the page (D-030), so the server sends it only to the browser the user
is looking at. The server can be wrong for up to 45 seconds (D-007), such as after a laptop slept
before its check-in went out. So the service worker hands a reaction to the open pages and shows
nothing, whoever is looking. A reaction push has a tag of its own, `reaction-` and the chat id, so
it can never replace a message notification.

Cost: a reaction push that reaches a browser nobody looks at shows nothing, and browsers count such
pushes. Chrome may show its own "updated in the background" notice, and Firefox counts it against
the site's quota of pushes without a notification. Safari never gets these pushes (D-047).

### D-031: Project invites notify even while the app is open

Accepted 2026-11-01 in #2.

Being added to a project sends a push to every device of the person added, saying who added them.
The service worker shows it even while the app is open and focused, because being added is rare and
the page has no alert of its own for it. Project names are not encrypted, so the server can write
this text itself. Being added to a group sends the same kind of push, which opens the group
(D-043).

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
when open tabs ask, 10 seconds when the user presses refresh, and 55 seconds for scheduled runs.
Review requests, reviews, comments from others, failed or fixed checks, conflicts, merges and closes
become events; one poll pushes at most the three most important. Polls start from open tabs, from a
timer on a self-hosted server (`GITHUB_POLL_SECONDS`, 120 by default), and from any scheduler that
calls `GET /api/github/poll` with `CRON_SECRET`. On Vercel, the database is that scheduler (D-057).

Cost: alerts arrive up to a few minutes after the change. Each list shows at most 30 pull requests,
and only from github.com.

### D-057: On Vercel, the database calls the GitHub poll every 2 minutes

Accepted 2026-11-02 in #29.

Vercel Hobby runs a cron job at most once a day, so the database keeps the clock. At start on
Vercel, the server makes sure a Supabase Cron job named `webchat-github-poll` exists; a matching job
is left alone, even a deactivated one. Every 2 minutes pg_cron runs it, and pg_net calls
`GET /api/github/poll` with a bearer secret that the server generated and keeps in `webchat.meta`.
The job reads the secret on every run, so it is not in the job's text. The server enables pg_cron
and pg_net itself, which Supabase allows its `postgres` role. Every `pollAll` run records its start.
The pane promises alerts with every tab closed only while the last run is under 10 minutes old, and
otherwise says alerts need an open tab (K-5). A tab's own poll does not count. A self-hosted server
polls once at start. Why: those alerts justify the server holding the token (D-033) and must stay
free (D-003); the database is already part of the free setup. GitHub Actions schedules run at
most every 5 minutes, are late when GitHub is busy, and stop after 60 days without activity.

Cost: the server enables two extensions and adds a job in the owner's database, up to 720 function
calls a day, about 2% of Hobby's monthly million. Where the role may not enable them, the server
logs why and the pane says so; `CRON_SECRET` still works. Anyone who can read the database can start
polls, at most one per account per minute. A paused Supabase project stops the clock.

### D-042: A shared pull request is a message with a card inside

Accepted 2026-11-01 in #8.

The share button on a pull request sends an ordinary message of kind "message" whose encrypted
content carries a `pull` field: repository, number, title, URL and the state at that moment, as
`PullCardDTO`. The text of the same message says the same in words, so an older page, a push
notification and the chat list show something without knowing the card. The page shows the card
instead of the text. When reading content, the page rebuilds the link from the repository and
number and drops a card whose link differs, so a card can only lead to github.com.

Why: a kind exists so the server can treat rows differently (D-030), and a shared pull request
should count, preview and push exactly like a message. So a field inside the envelope is enough,
and the server sees nothing about pull requests. The signature covers the envelope (D-016).

Cost: the card shows the state at the time of sharing and does not update. The text of a shared
pull request is a stock sentence that the user does not write.

### D-050: Projects link repositories through a GitHub App, and the server writes their cards

Accepted 2026-11-01 in #17. Supersedes D-046.

A project's owner links a repository by installing the WebChat GitHub App on it and signing in to
the app once. The server lists the repositories the owner reaches, revokes that token at once, and
lets the owner link only those, for half an hour. GitHub then sends a signed webhook for every pull
request event. When a pull request opens, is ready for review, is reopened, merged or closed, the
server writes a card into each channel that links the repository and pushes it like a message. The
card is a message of kind "github" with no sender and a plain JSON body. Pages show it with a "Not
encrypted" mark and rebuild its link from the repository and number (D-042). It names reviewers
and assignees as GitHub logins, and the viewer's own reads "you". The OAuth App serves only the
Pull requests pane (D-032 to D-034). Why: a team wants its pull requests in its channel with every
tab closed. The App gets webhooks and reads pull requests only. The server holds no chat key
(D-015), and it already reads titles for the pane (D-033).

Cost: the cards are the first messages the server writes, not end-to-end encrypted, and a changed
server could write fake ones; their links still lead only to github.com. The owner registers a
GitHub App with a public webhook address. A card does not update. Only someone who can install the
app can link a repository. Cards and pane name no requested team: reading one needs `read:org`, and
a query that asked without it made GitHub refuse the whole poll.

### D-060: The pane names an organization that hides its pull requests

Accepted 2026-11-03 in #34.

An organization that restricts OAuth Apps hides its pull requests from the token until one of its
owners approves WebChat (D-033). GitHub still answers the poll with the other pull requests, and
adds one FORBIDDEN error for each one it left out. The error's message names the organization;
nothing else in the answer does. `graphql` in `server/github.ts` returns those errors next to the
data, and the poll keeps the organizations they name in the stored lists as `hiddenOrganizations`.
The pane names them in a banner that links to GitHub's page on asking the owners for approval, and
the connect card says an organization may need to approve the app.

Why: course repositories often live in an instructor's organization, and only the owner's approval
can fix a hidden list, so the pane says so and to whom.

Cost: the server recognizes the restriction by the text of GitHub's error message, which no schema
fixes. If GitHub rewords it, the banner stops showing. An organization that enforces SAML single
sign-on hides its pull requests the same way, but its error names no organization, so the pane says
nothing for it. The banner was built against GitHub's answer as reports describe it, not against a
real organization.

## Engineering process

### D-035: Pull requests, squash merges and plain commit messages

Accepted 2026-11-01 in #1.

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

Why: GitHub's open pull requests are the only state every session can see, so the claim has to be
there, and first.

Cost: every pull request starts with an empty commit, which the squash merge drops. A claim depends
on the item id appearing in the branch name and the pull request text, so the script insists on
both. Numbers for decisions still race, which costs the loser a rename at merge time; the CI check
in D-063 fails on a duplicate `D-0xx` heading and catches that earlier.

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
stays 0, and any release may change anything. A version speaks to the people who run WebChat: the
settings and deploy steps in the README, the Node version `engines` pins (D-013), the stored data
that migrations upgrade in place (D-010), and tabs that still run the previous build. A change is
breaking when the person who runs WebChat must act during the upgrade, or when stored data or open
tabs stop working. The type in a pull request title sets the next version, because the squash merge
makes the title the commit subject on main (D-035):

- `fix` bumps the patch, and `feat` bumps the minor.
- A breaking change, marked with `!` after the type or a `BREAKING CHANGE:` footer, also bumps the
  minor below 1.0.0 (`bump-minor-pre-major` in `release-please-config.json`).
- Other types, such as `docs`, `ci` and `chore`, make no release on their own.

Release Please runs on every push to main (`.github/workflows/release-please.yml`). It keeps one
release pull request open, which updates `package.json`, `package-lock.json` and `CHANGELOG.md`.
Merging it tags `v0.y.z` and publishes a GitHub release; Vercel does not build that commit (D-058).
Nobody edits the version or the changelog by hand. Reaching 1.0.0 is the owner's call (Q-4); a
commit with `Release-As: 1.0.0` in its body proposes it.

Cost: a title with the wrong type gives the wrong version and changelog line. To fix one before the
release, add a `BEGIN_COMMIT_OVERRIDE` section to the merged pull request's body. Release Please
opens its pull request with `GITHUB_TOKEN`, so the setting "Allow GitHub Actions to create and
approve pull requests" must be on, and that pull request starts no other workflow.

### D-058: Vercel skips builds that ship the same app

Accepted 2026-11-02 in #30. `agent/` and `plugin/` joined the skipped paths in #103.

Vercel builds every push to main (D-041). `scripts/ignore-build.sh`, the Ignored Build Step in
`vercel.json`, skips a commit whose message starts with `chore(main): Release `. It also skips a
commit when nothing outside `docs/`, `test/`, `.github/`, `scripts/`, `agent/`, `plugin/` and
Markdown files changed since the last deployment, whose commit Vercel names in
`VERCEL_GIT_PREVIOUS_SHA`, so those deploys do not make every open tab check a new build (K-36).
When that commit is unknown or not in Vercel's shallow clone, the build runs. The release pull
request waits for the owner: it collects every `feat` and `fix` since the last release, so the owner
merges it when a set of changes is worth a version. Merging it automatically would bump the minor at
every `feat`, ship a wrong title type before `BEGIN_COMMIT_OVERRIDE` could fix it, and need a second
Release Please run to tag.

Cost: Vercel still clones the repository and records a canceled deployment for each release commit.
Only Release Please may use a title that starts like a release commit. A file in a skipped path that
the app starts to read at runtime must move out of those paths first.

### D-059: Message content is padded to a few fixed sizes

Accepted 2026-11-03 in #33.

Before `encryptMessage` encrypts the content, it pads it to the smallest power of two from 256
bytes that holds it, so a ciphertext is 256, 512, 1,024 bytes and so on, plus the AES-GCM tag. The
server learns which band a message falls in, not its length. A reaction, a reaction taken back and
a short message all land in the first band and look the same, which the README promises (K-8). The
padding is one 0x80 byte and then zeros, inside the AES-GCM ciphertext, so it is authenticated with
the content. The content is JSON, which ends with `}` and never holds a raw zero byte, so
`decryptContent` tells padded content from the unpadded content of older messages by the last
byte, and both still open. Nothing in the signed header changes (D-016). `LIMITS.ciphertextLength`
is the 32 KB band. Doubling bands reveal less than a fixed step, which shows a long message's
length to within the step, and cost at most half the band in padding.

Cost: every message costs at least 272 bytes of ciphertext, and a message of about 1,000 to 1,800
bytes of content now pads past the 3,000-byte push payload (D-017) and shows "New message" on the
lock screen.

### D-063: A check fails a pull request that repeats a decision or roadmap id

Accepted 2026-11-03 in #38.

The `doc-ids` workflow (`.github/workflows/doc-ids.yml`) runs on every pull request. It fails when
`docs/decisions.md` has two `### D-0xx:` headings with the same number, or `docs/roadmap.md` has two
`### K-n:`, `### R-nnn:` or `### Q-n:` headings with the same id. It is a few lines of `grep` and
`sort | uniq -d`, so it adds no dependency. The error names the file and the repeated id, and the
pull request that merges second renumbers its own entry, as AGENTS.md says.

Why: sessions take "the next free number" in parallel, and git sees no conflict when the two
entries land in different places in the file.

Cost: the check sees only the pull request's merge with main at the time it runs. Two open pull
requests that take the same number both pass until one merges, and the second has to be updated from
main to run the check again. Mark the check required in the branch rules, with "Require branches to
be up to date", or a red result will not stop the merge.

### D-076: Fix pull requests edit the roadmap in place, and CI runs the checks

Accepted 2026-11-03.

A pull request that finishes a roadmap item changes only that item's status line, in place. It
does not move the entry to Done or add a row to the Done table; a housekeeping pull request does
both for every finished item at once. New decision entries go at the end of their topic section,
and `.gitattributes` merges `docs/decisions.md` with git's union driver. `scripts/claim.sh` takes a
decision number as a third argument and refuses one that an open pull request already reserves.
`.github/workflows/ci.yml` runs typecheck, the tests and the build on every pull request, on main,
and in the merge queue.

Why: a status line changed in place touches different lines for different items, so parallel merges
go through clean. The union driver is safe for `decisions.md` because entries are never deleted. It
is not used for the roadmap, where entries move: union would restore what one side removed.

Cost: the Done section and its table lag behind until the next housekeeping pull request, so the
status lines are the current index. The union driver can interleave two entries added at the same
place in an odd order, which the next edit tidies. A merge queue is a repository setting, so the
owner turns it on and requires the `checks` job; until then CI runs, but merges are not
serialized.

### D-090: Documents say the current state, and an area's rules load with its code

Accepted 2026-11-05 in #97.

AGENTS.md holds only what the code cannot say: where the knowledge lives, the commands, the rules
that must hold, and the process. It has no map of the code; agents read the repository. The
constraints of each area live in `.claude/rules/<area>.md` behind a `paths` filter, one line per
constraint ending in its decision number, so Claude Code loads them when the area's files are
edited and any other agent reads the one file for its area. A decision entry states the decision
as it stands, why, and the cost, in at most 12 lines; a change rewrites the entry and git keeps the
history. A finished roadmap item becomes one row in the Done table and its entry goes. The pull
request template asks how the change was tested and how to undo it.

Why: on 2026-11-05 the three documents an agent was told to read came to about 55,000 tokens, and
entries narrated every pull request that touched them, so agents met several versions of the truth
and picked one. The Claude Code team keeps its shared instruction file near two thousand tokens,
scopes area rules by path, and rewrites instead of appending.

Cost: how a decision changed is in git history, not in the entry. A rules file and the log can
drift apart, and the doc-ids check does not read the rules files.

### D-091: The rules that a test can state have one

Accepted 2026-11-05 in #98.

Rules 3, 6, 7 and 8 of "Rules that must hold" in AGENTS.md each have a test, so breaking one fails
`npm test` and the pull request. `test/rules.test.ts` keeps one SHA-256 per entry of `MIGRATIONS`
and compares them in order, so an edit, a reorder or a removal fails and a new migration appends
one line, which the failure prints; the same file fails on `req.query` outside a comment under
`server/` and `api/`. `test/chat.test.ts` sends the longest message and checks that the push
payload is at most 3,000 bytes with no envelope and no plain text. `test/github.test.ts` fails any
`/api/github` answer that carries a GitHub token. Rules 1, 2, 4 and 5 hold for every future change
rather than one path, so no test states them in general; the chat and e2ee tests cover the paths
that exist.

Why: AGENTS.md said that breaking a rule is a bug even when every test passes, which named the gap:
a rule in prose depends on a reader, and D-090 concluded that such a rule belongs in a test or CI.

Cost: a fix to a comment inside an old migration changes its hash, so the fixture line changes and
a reviewer asks why. An alias such as `const r = req; r.query` passes the text check. The token
check sees only the routes the GitHub tests call.

## Superseded

Decisions that no longer hold. They keep their numbers and reasons for the record. Read the entry
that replaced each one instead.

### D-028: No leaving or removal before key rotation

Superseded by D-039. Accepted 2026-11-01 in #2.

Nobody could leave a project or be removed from one, because a removed member would still hold
every channel key. Groups could not take new members after creation. D-039 replaced it, and D-044
later added key rotation on leaving.

### D-046: New pull requests in a linked repository are shared by the author's browser

Superseded by D-050. Accepted 2026-11-01 in #14.

When a member's poll found their pull request in a linked repository that just became ready for
review, the server queued it and the author's page posted the card as the share button does (D-042).
The server holds no chat key (D-015), so only a browser could write it. D-050 replaced this with
cards that the GitHub App's webhooks post.

### D-084: Messages are one feed, not bubbles

Reverted on 2026-11-05: the owner prefers bubbles to a linear feed, so #78 was reverted and
R-023 is dropped. Was: Proposed 2026-11-05 in #78, step 2 of the move to a Slack-like look
(R-022 to R-026).

Messages would render in one column with an avatar gutter, with no colored own-message bubble. The
change was reverted, so messages stay in bubbles and no decision replaced it.
