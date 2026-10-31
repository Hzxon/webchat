# WebChat

A chat site for you and your friends, built so urgent messages are never missed. Friends text you
from any browser. You get an alert the moment they press send, on your desktop and your phone,
without waiting for an app to sync.

It runs for free on Vercel's Hobby plan with a free Supabase Postgres database.

## Features

- One-to-one and group chats, with history and online / last-active status.
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
over HTTP. It checks sign-up with the invite code, sync and its "unchanged" answer, delivered and
read receipts, access control, history paging, and logout. For push, it runs a fake push service,
checks which browsers get a push while the recipient is looking, looking away, or has closed the
tab, and decrypts a push to check its contents.

`npm run typecheck` checks the server, client, service worker, and tooling separately, since each
has its own environment.

## Project layout

```
api/      Vercel function entry point (wraps the Express app)
server/   Express API, Postgres queries, Web Push sender
client/   React app (Vite) and the service worker (client/src/sw.ts)
shared/   Types shared by server, client, and service worker
test/     Integration tests (node:test)
scripts/  Icon generator (npm run icons)
```

## Limits

- Text only: no voice or video calls, photos, or files yet. No typing indicator.
- With push turned off on a device, new messages show up on its next check-in (up to 3 seconds
  while you are looking, longer in the background).
- Messages are stored as plain text in the database. Transport is encrypted by HTTPS, and push
  payloads are encrypted for each browser, but this is not end-to-end encryption.
