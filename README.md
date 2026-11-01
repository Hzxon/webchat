# WebChat

A chat site for you and your friends, built so urgent messages are never missed. Friends text you
from any browser. You get an alert the moment they press send, on your desktop and your phone,
without waiting for an app to sync.

It runs for free on Vercel's Hobby plan with a free Supabase Postgres database.

## Features

- **End-to-end encryption**: messages are encrypted and signed in the browser. The server, Supabase
  and Vercel only ever store and relay ciphertext. Friends can compare a security code to confirm
  nobody is in between.
- One-to-one and group chats, with history and online / last-active status. The person who makes a
  group can remove people from it, or delete it for everyone.
- **Projects with channels**, for a team that works together, such as a class project. A project
  starts with #general, and any member can add channels such as #slides or #research. Everyone in a
  project is in all of its channels. Any member can add more people later, and newcomers can read
  the earlier messages too. The person who made the project can remove people from it, or delete it
  with every channel and message for everyone. Channels have their own Projects tab, with unread
  counts per channel.
- **Replies and reactions.** Reply to a message to quote it above yours, and tap the quote to jump
  to the original. React with one of six emoji; tap a reaction again to take it back.
- Sent, delivered, and read ticks.
- **Web Push notifications** that arrive when the tab or the browser window is closed, including on
  Android and on iPhone (as a Home Screen app, iOS 16.4 or later).
- **Urgent messages**: tap the bell next to the message box. The other person sees a full-screen
  alert, the page keeps ringing, and the tab title flashes until they open it. On their phone the
  notification stays until they act on it.
- Unread count in the tab title, favicon, and the app badge of an installed app.
- Invite-code sign-up, so only people you give the code to can join.
- **GitHub pull requests**: connect your GitHub account to see the pull requests waiting for your
  review and how your own are doing, with alerts when they change. See
  [GitHub pull requests](#github-pull-requests).

## How messages and notifications travel

The server runs as short-lived serverless functions, so there is no open connection to it. That
keeps it inside Vercel's free limits, where every open connection would use up the monthly
allowance in about a week.

- **Web Push is the fast path.** When someone sends a message, the server pushes it to the
  recipient's browsers. The service worker shows a notification, and tells any open tab to fetch
  the message at once.
- **Open tabs also check in** with `POST /api/sync`. A check-in returns nothing unless something
  changed. Tabs check in every 3 seconds while you look at them with push off, every 15 seconds with
  push on, and less often in the background.
- **Who gets the push.** Each check-in says whether you are looking at the tab: visible, focused,
  and active in the last 2 minutes. While you are, only that browser gets the push, so your phone
  stays quiet at the desk. Once you look away or close the tab, every device you enabled gets it.
  Safari gets no push while you look, except urgent ones, because it turns push off for a site
  whose pushes show nothing. Its tab checks in every 3 seconds instead.
- **Urgent** always alerts. An open tab rings until you dismiss it, even with message sounds off.
- **After a deploy, open tabs reload** on their next check-in, so a page from before it does not
  show new kinds of data as errors. A tab waits while you type in it, while it holds a draft or a
  message not sent yet, and while an urgent alert waits for you.

## End-to-end encryption

All of it runs in the browser with Web Crypto ([shared/e2ee.ts](shared/e2ee.ts)).

- **Your password never leaves the browser.** PBKDF2 (600,000 rounds) and HKDF turn it into two
  unrelated keys: a login key, which the server stores only as a scrypt hash, and a backup key.
- **Account keys** are a P-256 ECDH pair (receives chat keys) and an ECDSA pair (signs your
  messages). The private keys are stored on the server only sealed with the backup key, so signing
  in on any device unlocks your full history. On each device they live in IndexedDB as
  non-exportable keys, and signing out removes them.
- **Each chat has its own AES-256-GCM key.** Its creator wraps it for every member with a key from
  ECDH between the two of them, so a wrapped key proves who made it.
- **Every message is encrypted and then signed.** The signature covers the ciphertext, the chat,
  the sender, the urgent flag, and whether it is a message or a reaction. A message the server
  altered, or one a group member forged in someone else's name, shows as "could not be decrypted".
- **Replies and reactions are inside the envelope.** A reply carries the message it answers and a
  short quote of it. A reaction carries its emoji and the message it is for. The server sees neither.
  When the original of a quote is loaded, the app shows the original, whose signature it checked,
  instead of the quote the replier wrote.
- **Adding someone to a project.** The member who adds them opens their own copy of each channel
  key in the browser and wraps it for the newcomer. The server checks that every channel's key is
  included, so nobody joins with a channel they cannot read.
- **Removing someone.** Only the person who made the project or group can. Their browser wraps each
  chat key again for everyone who stays, and the server checks that every key comes for exactly
  them. Every copy left was then made by a current member, which each browser checks before it
  opens a key. The keys themselves stay the same; see below.
- **Notifications still show the text.** The push carries the encrypted message, and the service
  worker decrypts it on the device. A message too long for a push shows "New message".
- **Security codes.** The lock button in a chat shows a 60-digit code per person. If it matches on
  both phones, nobody swapped keys in between. Each device also remembers everyone's keys and warns
  if they ever change.

What it does not protect against:

- **Forgetting your password loses your encrypted history.** There is no reset.
- **A server that sends tampered app code.** Like any web app, the page runs the code the server
  sends, so encryption protects you from anyone who reads the database or the hosts, not from a
  malicious operator who changes the app itself.
- **Metadata stays visible to the server:** who talks to whom and when, group, project and
  channel names, who is in which project and who added them, who made each project and group,
  display names, whether a message is urgent, and that someone reacted (not with which emoji, or to
  which message).
- **Who gets a new channel's key comes from the server.** A new channel's key is wrapped for
  everyone the server lists as a project member. The New channel dialog names them, so check that
  list.
- **People removed from a project or group keep the keys they had.** Keys never rotate, so someone
  removed could still read later messages if they got them another way, for example from a copy of
  the database. The server stops sending them anything.
- **Someone who writes to the database can add unencrypted messages** under any member's name.
  They show as "Not encrypted", in the chat and in every preview, and never alert.
- **Accounts from before encryption** upgrade once: on the next visit the app asks for the password,
  and that one request sends it to the server so it can be checked against the old hash. Messages
  from before stay readable and are marked "Not encrypted".

## Run it locally

Requires Node.js 26, the version `engines` in `package.json` pins. No database setup is needed:
without `DATABASE_URL`, the server uses an embedded Postgres (PGlite) stored in `data/pglite`.

```bash
npm install
npm run dev
```

Open http://localhost:5173. The server log prints the invite code for new accounts. Vite serves the
client on port 5173 and proxies `/api` to the server on port 3000.

Browsers allow notifications and push on `http://localhost` without HTTPS. In the app, click the
bell icon, then **Turn on notifications**, then **Send a test notification**.

## Deploy to Vercel (free) with Supabase (free)

1. Sign in to Vercel, link this folder to a new project, and add a free Supabase database to it in
   the same region as the function (`regions` in [vercel.json](vercel.json), `sin1` here). The
   Supabase integration sets `POSTGRES_URL` on the project.

   ```bash
   npx vercel login
   ```

   ```bash
   npx vercel link --yes
   ```

   ```bash
   npx vercel integration add supabase --billing-plan free --meta region=sin1
   ```

2. Choose the invite code your friends will type to sign up. The command asks for the value:

   ```bash
   npx vercel env add INVITE_CODE production
   ```

   The Web Push keys need no setup: the first server start generates a pair and keeps it in the
   database. Optional settings: `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` to bring your own pair
   (never change it later), `VAPID_SUBJECT` (defaults to the site's production URL), and
   `DATABASE_CA_CERT` (Supabase's root CA, to verify the database server).

3. Deploy:

   ```bash
   npx vercel deploy --prod
   ```

Vercel serves `dist/client` as static files and runs `api/index.ts` (the Express app) as one
function for every `/api/*` request. The tables live in their own `webchat` schema, which
Supabase's auto-generated REST API does not expose.

Only `main` deploys from Git. Other branches get no preview, because a preview cannot connect
GitHub, since the OAuth App has one callback URL, and would run a branch's new migration on the
shared database. To try a branch on a real phone, deploy it by hand with `npx vercel deploy`.

Share the address and the invite code with your friends, or send a link that fills in the code:
`https://your-app.vercel.app/?invite=YOUR_CODE`.

### Free plan limits to know

- Vercel Hobby is for personal, non-commercial use.
- Supabase pauses a free project after about a week with no activity. Anyone using the chat keeps it
  awake. If it pauses, resume it from the Supabase dashboard.

### Turning on notifications on each device

- **Desktop (Chrome, Edge, Firefox, Safari)**: sign in, click the bell icon, then
  **Turn on notifications**. Push arrives while the browser is running, even with the tab closed.
- **Android (Chrome)**: same as desktop. Push arrives even when Chrome is closed.
- **iPhone and iPad**: open the site in Safari, tap Share, then **Add to Home Screen**. Open
  WebChat from the Home Screen, sign in, and turn on notifications there. Safari tabs on iOS cannot
  receive push.

## GitHub pull requests

Each person can connect their own GitHub account. A **Pull requests** entry at the top of the chat
list then shows the open pull requests waiting for their review (asked of them or one of their
teams), their own open pull requests with checks, review decision, merge conflicts, size and
comments, and recent activity.

WebChat alerts you the same way as a message when someone asks for your review, approves or asks
for changes on your pull request, comments on it, its checks fail or pass again, it gets merge
conflicts, or it is merged or closed. Clicking the alert opens the pull request on GitHub. The
pane has a switch to turn these alerts off.

### Set it up

1. On GitHub, open [New OAuth App](https://github.com/settings/applications/new) (Settings >
   Developer settings > OAuth Apps). Set the homepage URL to your site and the authorization
   callback URL to `https://your-app.vercel.app/api/github/callback`. Register it, then generate a
   client secret.
2. Give the server the client ID and the secret. Each command asks for the value:

   ```bash
   npx vercel env add GITHUB_CLIENT_ID production
   ```

   ```bash
   npx vercel env add GITHUB_CLIENT_SECRET production
   ```

3. Deploy again. The **Pull requests** entry appears for everyone, and each person presses
   **Connect GitHub** in it.

An OAuth App has one callback URL, so register a second one for local development with
`http://localhost:5173/api/github/callback`, and start the dev server with its values:
`GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... npm run dev`.

### How it watches

GitHub does not tell WebChat when a pull request changes, so the server asks. It asks at most once a
minute per account, with one GraphQL query, a small part of the 5,000 points an hour GitHub allows
each person. It compares the answer with the last one and records what changed.

- **While any WebChat tab is open**, even in the background, the tab makes the server check every 1
  to 3 minutes.
- **A self-hosted server** (`npm start`) also checks every connected account on its own every 2
  minutes (`GITHUB_POLL_SECONDS`), so alerts arrive with every tab closed.
- **On Vercel**, functions stop between requests, and Hobby cron jobs run only once a day. For alerts
  with every tab closed, set `CRON_SECRET` and have a scheduler call `GET /api/github/poll` with
  `Authorization: Bearer <CRON_SECRET>` every few minutes. For example, a GitHub Actions workflow in
  any of your repositories, with the secret saved as `WEBCHAT_CRON_SECRET`:

  ```yaml
  on:
    schedule:
      - cron: '*/5 * * * *'
  jobs:
    poll:
      runs-on: ubuntu-latest
      steps:
        - run: curl -fsS -H "Authorization: Bearer ${{ secrets.WEBCHAT_CRON_SECRET }}" https://your-app.vercel.app/api/github/poll
  ```

  GitHub runs scheduled workflows at most every 5 minutes and can delay them when busy. On a Vercel
  plan with frequent cron jobs, add `"crons": [{ "path": "/api/github/poll", "schedule": "*/5 * * * *" }]`
  to [vercel.json](vercel.json) instead. Vercel sends `CRON_SECRET` by itself.

### What it can access

- OAuth Apps cannot get read-only access to private repositories, so GitHub asks for the `repo`
  scope: full access to your repositories. WebChat only reads pull requests with it.
- The token never reaches the browser. The server stores it encrypted (AES-256-GCM) with a key
  derived from `GITHUB_CLIENT_SECRET`, which lives only in the environment, so a copy of the
  database alone cannot use it. Changing the client secret makes everyone connect again.
- Unlike messages, pull request titles and repository names are not end-to-end encrypted: the
  server fetches them, and keeps the latest list and 50 recent events in the database.
- **Disconnect** deletes the token and the app's grant on GitHub. Revoking the app on GitHub
  (Settings > Applications) works too; the pane then asks you to connect again.
- An organization that restricts OAuth Apps hides its pull requests until an owner approves the app.

## Self-hosting instead

`npm run build && npm start` runs everything in one Node process on `PORT` (default 3000), with
PGlite or any Postgres in `DATABASE_URL`. Put it behind HTTPS (for example Caddy) and set
`TRUST_PROXY=1`. See [.env.example](.env.example) for every setting.

## Tests

```bash
npm test
```

The integration test runs the app on a random port with an in-memory PGlite database and drives it
over HTTP, with every client doing real encryption. It checks that the database and pushes hold no
plain text, that a message the server alters is rejected, the one-time upgrade of old accounts,
chat keys, receipts, access control, and which browsers get a push while the recipient is looking,
looking away, or has closed the tab. For projects it checks that channel keys must cover exactly
the members, that a person added later reads the earlier messages, and that replies and reactions
stay encrypted and reactions never count as unread. Only the owner of a project or group can remove
people or delete it; a removal must wrap every key again for exactly the people who stay, the
person removed loses access at once, and someone whose copy they had wrapped can still open it. The crypto tests cover wrong passwords, swapped
keys, tampering, forged senders, sharing a chat key with a newcomer, and security codes. The GitHub
tests run against a fake GitHub: the sign-in's state and PKCE checks, the encrypted token, which
changes become alerts, the scheduler secret, a revoked token, and disconnecting.

`npm run typecheck` checks the server, client, service worker, and tooling separately, since each
has its own environment.

## Project layout

```
api/      Vercel function entry point (wraps the Express app)
server/   Express API, Postgres queries, Web Push sender
client/   React app (Vite), the service worker (client/src/sw.ts), and the key store (client/src/e2ee)
shared/   Types and the end-to-end encryption code shared by server, client, and service worker
test/     Integration tests (node:test)
scripts/  Icon generator (npm run icons)
docs/     Decisions and roadmap, the source of truth for anyone changing the code
```

Before you change the code, read [AGENTS.md](AGENTS.md). It links to
[docs/decisions.md](docs/decisions.md), which records why the code is the way it is, and to
[docs/roadmap.md](docs/roadmap.md), which lists planned work, known issues and open questions.

## Limits

- Text only: no voice or video calls, photos, or files yet. No typing indicator.
- With push turned off on a device, new messages show up on its next check-in (up to 3 seconds
  while you are looking, longer in the background).
- No key rotation: a chat keeps one key for its lifetime, so people removed from it keep that key.
  People can join a project later, but not a group. Only the person who made a project or group can
  remove people or delete it. Nobody can leave on their own, and the owner cannot hand it over.
- Reactions never notify anyone. They show up at once in a chat that is open, and otherwise on the
  next check-in.
- Adding someone to a project needs a member whose browser can open every channel key. Up to 20
  people can be added at a time.
- Pull requests show at most 30 per list, and only from github.com, not GitHub Enterprise Server.
  Changes show up on the next check, up to a few minutes later, not the moment they happen.
