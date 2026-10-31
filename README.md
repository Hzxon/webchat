# WebChat

A chat site for you and your friends, built so urgent messages are never missed. Friends text you
from any browser. You get an alert the moment they press send, on your desktop and your phone,
without waiting for an app to sync.

It runs for free on Vercel's Hobby plan with a free Supabase Postgres database.

## Features

- **End-to-end encryption**: messages are encrypted and signed in the browser. The server, Supabase
  and Vercel only ever store and relay ciphertext. Friends can compare a security code to confirm
  nobody is in between.
- One-to-one and group chats, with history and online / last-active status.
- **Projects with channels**, for a team that works together, such as a class project. A project
  starts with #general, and any member can add channels such as #slides or #research. Everyone in a
  project is in all of its channels. Any member can add more people later, and newcomers can read
  the earlier messages too. Channels have their own Projects tab, with unread counts per channel.
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
- **Urgent** always alerts. An open tab rings until you dismiss it, even with message sounds off.

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
- **Notifications still show the text.** The push carries the encrypted message, and the service
  worker decrypts it on the device. A message too long for a push shows "New encrypted message".
- **Security codes.** The lock button in a chat shows a 60-digit code per person. If it matches on
  both phones, nobody swapped keys in between. Each device also remembers everyone's keys and warns
  if they ever change.

What it does not protect against:

- **Forgetting your password loses your encrypted history.** There is no reset.
- **A server that sends tampered app code.** Like any web app, the page runs the code the server
  sends, so encryption protects you from anyone who reads the database or the hosts, not from a
  malicious operator who changes the app itself.
- **Metadata stays visible to the server:** who talks to whom and when, group, project and
  channel names, who is in which project and who added them, display names, whether a message is
  urgent, and that someone reacted (not with which emoji, or to which message).
- **Who gets a new channel's key comes from the server.** A new channel's key is wrapped for
  everyone the server lists as a project member. The New channel dialog names them, so check that
  list.
- **Accounts from before encryption** upgrade once: on the next visit the app asks for the password,
  and that one request sends it to the server so it can be checked against the old hash. Messages
  from before stay readable and are marked "Not encrypted".

## Run it locally

Requires Node.js 22.13 or later. No database setup is needed: without `DATABASE_URL`, the server
uses an embedded Postgres (PGlite) stored in `data/pglite`.

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
stay encrypted and reactions never count as unread. The crypto tests cover wrong passwords, swapped
keys, tampering, forged senders, sharing a chat key with a newcomer, and security codes.

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
```

## Limits

- Text only: no voice or video calls, photos, or files yet. No typing indicator.
- With push turned off on a device, new messages show up on its next check-in (up to 3 seconds
  while you are looking, longer in the background).
- No key rotation: a chat keeps one key for its lifetime. People can join a project later, but not
  a group. Nobody can leave a project or be removed from it yet; since keys never rotate, a removed
  member would still hold the keys they had.
- Reactions never notify anyone. They show up at once in a chat that is open, and otherwise on the
  next check-in.
- Adding someone to a project needs a member whose browser can open every channel key. Up to 20
  people can be added at a time.
