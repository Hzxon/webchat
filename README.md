# WebChat

A chat site for you and your friends, built so urgent messages are never missed. Friends text you
from any browser. You get an alert the moment they press send, on your desktop and your phone,
without waiting for an app to sync.

It runs for free on Vercel's Hobby plan with a free Supabase Postgres database.

## Features

- **End-to-end encryption**: messages are encrypted and signed in the browser. The server, Supabase
  and Vercel only ever store and relay ciphertext. Friends can compare a security code to confirm
  nobody is in between.
- One-to-one and group chats, with history and online / last-active status. Any member can add
  people to a group later, and newcomers can read the earlier messages too. Anyone can leave a
  group. Its owner, who made it or was handed it, can remove people or delete it for everyone.
- **Projects with channels**, for a team that works together, such as a class project. A project
  starts with #general, and any member can add channels such as #slides or #research. Everyone in a
  project is in all of its channels. Any member can add more people later, and newcomers can read
  the earlier messages too. Any member can leave. The project's owner can remove people, hand the
  project to another member, delete any channel but #general with its messages, or delete the
  project with every channel and message for everyone. An owner hands it over before leaving.
  Channels have their own Projects tab, with unread counts per channel.
- **Shared docs in projects**, such as a PRD, a spec or meeting notes, so a team writes them next
  to its channels instead of mailing Word files around. A doc starts from a template and is written
  in Markdown, section by section. One person edits a section at a time, and everyone else sees who.
  Each section keeps its history: see what every edit changed, and bring back an earlier version.
  The print button saves a doc as a PDF to hand in. Docs are end-to-end encrypted like messages.
- **A board in each project** with two columns: the team's numbered decisions, each with why it
  was made and what it costs, and its roadmap of ideas and issues. A card is Markdown in the same
  format as this repository's own decision log and roadmap, so "Copy as Markdown" gives a file a
  team drops into its repository for the coding agents it runs. Cards are edited like doc sections,
  one person at a time, with the same history. The roadmap shows its cards in three lanes, Ready,
  Running and In review, with open cards in a drawer under them. Each card shows the face of the
  member who opened it, or a dashed mark when nobody owns it: a card from before owners, an
  imported one, or one whose opener left. Cards move by buttons. Only a card's owner marks it
  ready or closes it; any member asks them to mark it ready, which reaches them as a message in
  your direct chat, picks a ready card or sends a picked one to review. Any member can take a
  card with no owner in Open or Ready, and becomes its owner. Only the owner deletes a card that
  has one. When someone edits a card to a status only its owner may set, the card keeps its status
  and says who tried. Any member asks any member to review a card in review, who approves it or asks
  for changes in one line. Its owner accepts or declines a change, runs the card again once they
  accepted one, and closes it only after an approval, with no change open. A verdict counts only
  from the reviewer's own edit, and an answer only from the owner's. A running card that waits for
  a decision stands out and names its owner, who gets a message about it.
- **Replies and reactions.** Reply to a message to quote it above yours, and tap the quote to jump
  to the original. React with one of six emoji; tap a reaction again to take it back.
- Sent, delivered, and read ticks.
- Drafts, and messages that could not be sent, stay on the device until they are sent, so closing
  the tab loses nothing.
- **Web Push notifications** that arrive when the tab or the browser window is closed, including on
  Android and on iPhone (as a Home Screen app, iOS 16.4 or later). An older iPhone gets its alerts
  through the free Bark app instead.
- **Urgent messages**: tap the bell next to the message box. The other person sees a full-screen
  alert, the page keeps ringing, and the tab title flashes until they open it. With the tab closed
  or the phone locked, the notification rings again every 15 seconds until they open the chat.
- Unread count in the tab title, favicon, and the app badge of an installed app.
- Invite-code sign-up, so only people you give the code to can join, with one account per device.
  You can delete your account from the sidebar: you leave every chat, your direct chats are deleted
  for both people, and your name and device are free for a new account.
- **GitHub pull requests**: connect your GitHub account to see the pull requests waiting for your
  review and how your own are doing, with alerts when they change, and share one into a chat as a
  card that names its reviewers. A project can link its repositories through the WebChat GitHub App,
  so every pull request in them shows up in a channel as a card. See
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
- **iPhones without Web Push** get alerts through the Bark app. The server sends the alert to Apple
  itself, with the key Bark's author publishes, whenever a Web Push would go to your other devices.
  It carries the chat and sender names and never the text. See "Turning on notifications".
- **Urgent** always alerts. An open tab rings until you dismiss it, even with message sounds off.
  While you look away, the server sends the push again every 15 seconds, like an alarm, until you
  read the chat or the message is 3 days old. Silent mode and Do Not Disturb still mute it, except
  through Bark with critical alerts allowed. On Vercel, a Supabase Cron job, `webchat-urgent-ring`,
  keeps that clock, as for GitHub polls.
  An urgent message that came while WebChat was closed alerts when you open it, if you have not
  read it and it is at most 3 days old. The browser may hold the sound until your first tap.
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
- **Every message is padded before it is encrypted**, to the smallest of a few fixed sizes that
  holds it: 256 bytes, 512 bytes, 1 KB and so on. A reaction, a reaction taken back and a short
  message all look the same to the server.
- **Replies and reactions are inside the envelope.** A reply carries the message it answers and a
  short quote of it. A reaction carries its emoji and the message it is for. The server sees neither.
  When the original of a quote is loaded, the app shows the original, whose signature it checked,
  instead of the quote the replier wrote.
- **Adding someone to a project or group.** The member who adds them opens their own copy of each
  chat key in the browser and wraps it for the newcomer. The server checks that every key is
  included, so nobody joins a chat they cannot read.
- **A new key when someone leaves or is removed.** The chat gets a new key, wrapped for everyone
  who stays and never for the person who left, so they cannot read what is sent next. The old key
  travels inside the new one, so members, and anyone added later, still read the whole history.
  When the owner removes someone, the owner's browser makes the new keys in the same step. When
  someone leaves, the chat takes no new messages until the browser of a member who stays makes the
  new key, which an open tab does on its next check-in.
- **Notifications still show the text.** The push carries the encrypted message, and the service
  worker decrypts it on the device. A message too long for a push shows "New message".
- **Security codes.** The lock button in a chat shows a 60-digit code per person. If it matches on
  both phones, nobody swapped keys in between. Each device also remembers everyone's keys and warns
  if they ever change. Until you check the new code, that person's new messages show as unreadable.

What it does not protect against:

- **Forgetting your password loses your encrypted history.** There is no reset.
- **Drafts and messages not sent yet are stored on your device unencrypted**, until they are sent or
  you sign out. Anyone with access to the browser's files can read them.
- **A server that sends tampered app code.** Like any web app, the page runs the code the server
  sends, so encryption protects you from anyone who reads the database or the hosts, not from a
  malicious operator who changes the app itself.
- **Alerts through Bark pass Apple.** For an iPhone linked to Bark, Apple sees when an alert goes
  to it, and, unless encryption is turned on in the bell dialog, the chat and sender names in it.
  The Bark app on the phone sees the alert in full. The message text is never in it.
- **Metadata stays visible to the server:** who talks to whom and when, group, project and
  channel names, who is in which project or group and who added them, who owns each project and
  group, who left, when a chat got a new key, display names, whether a message is urgent, that
  someone reacted (not with which emoji, or to which message), which messages are a coding agent's
  board traffic with its owner's page (not what they say), and roughly how long a message is:
  which of the fixed sizes it was padded to, not its exact length.
- **Who edits which doc section, and when.** The server sees which docs a project has, how many
  sections each has, who edited which section and when, who is editing one now, and which of the
  fixed sizes each section was padded to. It never sees a title or the text. It could hide the
  newest edits of a section and show an older one, as it could hold back messages. On the board
  it could also hold back a member's edit of a card, or a card's first revision, so the card looks
  as if nobody owns it, but it cannot make a move that is not that member's. Right after a card is
  saved, it can guess that a direct message is a request about that card.
- **Which GitHub repositories a project links, and the cards from GitHub in its channels.** The
  server writes those cards from what GitHub sends, so they are not end-to-end encrypted, and a
  server that was changed could write fake ones. Their links still lead only to github.com. A card
  someone shares by hand is encrypted like any message.
- **A board copied into a repository.** When a project's owner links its board to a repository,
  the board's cards and decisions are written to that repository's `docs/roadmap.md` and
  `docs/decisions.md` in plain text. GitHub, and everyone who can read the repository, can read
  them.
- **Who gets a new channel's key comes from the server.** A new channel's key is wrapped for
  everyone the server lists as a project member. The New channel dialog names them, so check that
  list. The same goes for the new key a chat gets after someone leaves.
- **An agent's keys live in a file on its owner's machine.** A coding agent that a project runs
  (the roadmap's R-027) has an account of its own. The Claude Code plugin keeps that account's
  private keys and session in its data folder, `~/.claude/plugins/data/`, and the daemon in
  `~/.webchat/laptop/`. Both files are readable only by their owner, but not
  encrypted. Anyone who can read one can read what the agent's projects write. The server knows
  which accounts are agents, whose agent each one is, and the names of the GitHub repositories its
  laptop has a folder for, the ones you connected or had it clone, never where they are. It learns
  that the agent is online whenever a Claude Code window is open on that laptop, in any folder, or the daemon runs, and
  what the laptop can do, such as answer questions, which tells newer plugins from older ones.
  It sees a run as messages like any other.
  Pairing shows it the agent's public keys and proofs made from the code, never the code.
- **People who leave keep the keys they had.** Someone who left or was removed could still read the
  messages from before, if they got them another way, for example from a copy of the database.
  Everything sent after they left uses a new key they never get.
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

   To alert iPhones that cannot get Web Push, add `BARK_APNS_KEY`: the APNs key that
   [Bark's documentation](https://github.com/Finb/Bark/blob/master/docs/en-us/cert.md) publishes
   for self-hosted servers, as the text of the `.p8` file. Its id and team id are built in;
   `BARK_APNS_KEY_ID` and `BARK_APNS_TEAM_ID` override them for a build of Bark with another key.
   Without the variable, the bell dialog says Bark is not set up.

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
- **iPhone or iPad before iOS 16.4**, which has no Web Push at all: install the free
  [Bark](https://apps.apple.com/app/id1403753865) app. In WebChat, open the bell, press **Link
  Bark**, and copy the server URL it shows. In Bark, open the server list, add that URL, and
  allow notifications and critical alerts, so urgent messages ring even on silent. If you skipped
  critical alerts, turn them on for Bark in the iPhone's Settings, under Notifications. Bark
  registers itself; the dialog then counts the phone, and alerts arrive
  whenever you are not looking at WebChat on another device. Alerts name the chat and the sender,
  never the text, and a tap opens the chat in Safari. To keep even those names from Apple, press
  **Turn encryption on**, then in Bark open Push Encryption, choose AES256 and GCM, and type the
  key the dialog shows. Needs `BARK_APNS_KEY` on the server, see the deploy steps.

## GitHub pull requests

Each person can connect their own GitHub account. A **Pull requests** entry at the top of the chat
list then shows the open pull requests waiting for their review (asked of them or one of their
teams), their own open pull requests with checks, review decision, merge conflicts, size and
comments, and recent activity.

The share button on a pull request sends it into a chat or channel as a card: the title, the
repository and number, how it stood at that moment, who still has to review it and who it is
assigned to, with a link to GitHub. A reviewer who sees their own GitHub login there reads "you".
The card is encrypted like any message, so the server does not learn which pull request was shared.

A project's owner can link its GitHub repositories with the GitHub button on the project. They
install the WebChat GitHub App on the repository, sign in to it once, and pick the repository and a
channel, #general by default. From then on, GitHub tells WebChat about every pull request in the
repository, whoever opens it. WebChat posts a card into the channel when a pull request opens, and
a short card when it is ready for review, reopened, merged or closed. Members get a push, as for a
message. Nobody has to connect GitHub for this. Everyone in the project sees each card, even
without access to the repository. The server writes these cards, so unlike the cards people share,
they are not end-to-end encrypted.

WebChat alerts you the same way as a message when someone asks for your review, approves or asks
for changes on your pull request, comments on it, its checks fail or pass again, it gets merge
conflicts, or it is merged or closed. Clicking the alert opens the pull request on GitHub. The
pane has a switch to turn these alerts off.

### Set up the Pull requests pane

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

### Set up project repositories

Projects link repositories through a GitHub App, a separate registration from the OAuth App above.

1. On GitHub, open [New GitHub App](https://github.com/settings/apps/new) (Settings > Developer
   settings > GitHub Apps). Fill it in:
   - **GitHub App name**: any name, such as "WebChat for Capstone". Note the name in the app's URL
     on GitHub, such as `webchat-for-capstone`.
   - **Homepage URL**: your site.
   - **Callback URL**: `https://your-app.vercel.app/api/github/app/callback`. Add
     `http://localhost:5173/api/github/app/callback` too, for local development.
   - Leave **Request user authorization (OAuth) during installation** off.
   - **Setup URL**: `https://your-app.vercel.app/api/github/app/setup`, with **Redirect on update**
     ticked.
   - **Webhook URL**: `https://your-app.vercel.app/api/github/webhook`, and a **Webhook secret**.
     `openssl rand -hex 32` makes a good one.
   - **Repository permissions**: Pull requests, Read-only. Nothing else.
   - **Subscribe to events**: Pull request.
   - **Where can this GitHub App be installed**: Any account, so students can install it on their
     own repositories.
2. Create the app, then generate a client secret on its page.
3. Give the server the app's URL name, its client ID, the client secret and the webhook secret. Each
   command asks for the value:

   ```bash
   npx vercel env add GITHUB_APP_SLUG production
   ```

   ```bash
   npx vercel env add GITHUB_APP_CLIENT_ID production
   ```

   ```bash
   npx vercel env add GITHUB_APP_CLIENT_SECRET production
   ```

   ```bash
   npx vercel env add GITHUB_WEBHOOK_SECRET production
   ```

4. Deploy again. A project's owner opens the GitHub button on the project and presses **Install on
   GitHub**.

GitHub cannot reach `localhost`, so local development of webhooks needs a tunnel, such as
[smee.io](https://smee.io).

### How the pane watches

GitHub does not tell the OAuth App when a pull request changes, so the server asks. It asks at most once a
minute per account, with one GraphQL query, a small part of the 5,000 points an hour GitHub allows
each person. It compares the answer with the last one and records what changed.

- **While any WebChat tab is open**, even in the background, the tab makes the server check every 1
  to 3 minutes.
- **A self-hosted server** (`npm start`) also checks every connected account on its own every 2
  minutes (`GITHUB_POLL_SECONDS`), so alerts arrive with every tab closed.
- **On Vercel with Supabase**, functions stop between requests, and Hobby cron jobs run only once a
  day. So the database keeps the clock. When the server starts, it enables Supabase's `pg_cron` and
  `pg_net` extensions and adds a Supabase Cron job, `webchat-github-poll`, that calls
  `GET /api/github/poll` every 2 minutes. There is nothing to set up. To stop it, deactivate the job
  on Supabase's Cron page: WebChat leaves a deactivated job alone.
- **With another Postgres on Vercel**, or if Supabase refuses the extensions (the server log says
  why), set `CRON_SECRET` and have a scheduler call `GET /api/github/poll` with
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

When nothing has polled on a schedule for 10 minutes, the pane says that alerts arrive only while a
WebChat tab is open.

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
  The pane names the organization and links to how a member asks for that approval.
- The GitHub App can only read pull requests, and only in the repositories it is installed on.
  Signing in to it to link a repository lists those repositories, and WebChat revokes that sign-in
  at once, so it keeps no token of the app. GitHub signs every webhook with the webhook secret, and
  WebChat drops any that does not match.
- A team asked to review does not show, in the pane or on cards. Reading teams needs the
  `read:org` scope, which WebChat does not ask for.

## Run board cards with a coding agent

You can hand an issue or idea card on your project's board to a coding agent on your own machine.
The agent gets an account of its own, and runs only the cards you hand it. Two programs can host it,
and a laptop uses one of them:

- **The Claude Code plugin** is the first choice for anyone who uses Claude Code. It is one install,
  and it serves while a Claude Code window is open.
- **The daemon** is for a laptop where no Claude Code window stays open. You start it yourself and
  keep it running.

### With the Claude Code plugin

It works on a Mac or on Linux, and on Windows only in WSL2: Claude Code's sandbox, which keeps your
keys from the agent, does not run on Windows. On Linux the sandbox needs `bubblewrap` and `socat`.

1. In WebChat, open **Coding agents** at the top of your chats and choose **Connect coding
   agent**. Copy the code it shows.
   It starts with your WebChat's address, so the plugin knows where to connect. It works once,
   within 10 minutes.
2. In Claude Code, type `/plugin install webchat --marketplace Hzxon/webchat#plugin` (Claude Code
   2.1.275 or later). Paste the code when it asks for one. To pair again later, type
   `/plugin configure webchat@webchat` and paste a new code. The old agent stays, asleep, until you
   remove it under the **+** button in **Coding agents**.
3. Open Claude Code on that laptop, in any folder, in the terminal or the Claude desktop app. Back
   in WebChat, approve the agent, name it, and pick the projects it joins. Keep one Claude Code
   window open: it serves every repository the agent works in, and a second window waits, and takes
   over when the first closes. Background jobs never serve.
4. Hand the agent a card, or ask it about a repository. When the laptop has no copy of the
   repository, the agent says so and offers **Clone it**. On your click it clones the repository
   into `~/WebChat/<owner>/<name>` with your GitHub login, and goes on. It clones only a repository
   one of your projects links. To use a copy you already have instead, open Claude Code in it and
   type `/webchat:connect`, then approve the `connect` tool: Claude Code asks about it on every
   call. To undo that, ask Claude there to disconnect WebChat. The files stay.

Under **Coding agents**, the pane lists your projects. Each shows its repositories and whether your
agent has them on the laptop, with **Forget** to drop a folder, which leaves its files. Then come
the project's conversations. Ask in a project and one of its repositories. A project that links no
repository gets answers from its board alone: its decisions and cards.

When you ask your agent to draft a card or a decision, it first checks the draft against the
board's cards and decisions, the code and the repository's open pull requests. The draft lists what
it repeats or goes against, with a warning for a decision it goes against, and nothing stops you
from adding it. A card you add carries a `Checked:` line with the date and what the check read. An
open idea or issue without one shows as **Unchecked** on the board, and **Check again** on a card
asks your agent to check it as it is now. The board gives each new card its number under a lock,
so two people adding a card at once get two numbers.

The project's owner can link the board to one of the project's repositories, from the board. The
repository's entries in `docs/roadmap.md` and `docs/decisions.md` come onto the board first, with
the numbers they have. From then on the owner's agent keeps both files as copies of the board. When
the board has not changed for 10 minutes, the agent pushes its changes to the `agent/board` branch,
in one draft pull request that the owner merges. It pushes only that branch, and never forces a
push. Nobody edits a copy by hand: a pull request in the repository proposes a change as a file
under `docs/roadmap/` or `docs/decisions/`, and once that file is on the default branch, it reaches
the owner as a draft. An open pull request whose body starts with `Claims K-12` marks that card
`Running: repo#N` on the board, unless it has an owner who has not marked it ready. One repository holds the copy of one board.

Cards and clones also need GitHub on that laptop: the GitHub CLI signed in with `gh auth login`, and
git using it after `gh auth setup-git`. `/webchat:connect`, typed in any folder, says when they are
missing, and Claude Code can set them up with you. Questions about a repository the laptop has need
neither.

On Linux without a desktop keyring, Claude Code keeps the pairing code in
`~/.claude/.credentials.json`, readable only by you. The code works once, so it is useless after
pairing.

On a roadmap card, the play button opens the card's brief under **Coding agents**: the card and the
decisions it follows, as your agent will get them, with each passage a teammate wrote marked. Pick
the repository and press **Start**. When it cannot start, the brief says why: the laptop is asleep,
Claude Code there needs a GitHub sign-in, or someone is editing the card. Your agent runs several
cards at once, each in a worktree of its own, and refuses only a second start of a card it runs.
When you start a card, the plugin checks that you sent it and that its brief is still the one you
saw, adds a git worktree inside the repository's folder, and starts a background Claude there. It runs apart from your own sessions,
which keep their settings. It reads none of your Claude Code settings and none of the repository's
hooks or `.mcp.json`.

Under **Settings** in **Coding agents**, you choose what your agent's runs and answers load from
Claude Code on its laptop: your `~/.claude/CLAUDE.md`, any of your skills in `~/.claude/skills`,
and no AI attribution lines in its commits and pull requests. Each run gets a copy of the skills, so
it never edits yours. Your settings, hooks, MCP servers, plugins and permission rules stay off,
since a run follows cards your teammates wrote. Settings shows what the last run loaded.

The background Claude runs in a sandbox that fails closed: if the sandbox cannot start, the run
does not. Its shell reaches only the npm registry. It cannot read the plugin's keys, the folder of
`gh`, the macOS keychain, Claude Code's `session-env` folder or the rest of your home folder. The
`session-env` folder is where SessionStart hooks leave the environment, tokens included. The shell
can read the repository, its `.git` and temporary folders. So the plugin refuses a run when
origin's https address holds a login. The shell gets no environment variable named like a token,
secret, password, API key, access key, private key, credential or auth. It gets none that holds a
known token prefix or a password in a URL. It can search the web and read pages, so a page it reads
could make it leak the repository's code. The card goes in on stdin, and the turn ends with a JSON answer.

A run takes the steps a session in this repository takes. The plugin first refuses a card that an
open pull request claims, and names that pull request. The background Claude's first turn checks
that the card still holds, against the code, the decisions and the other cards, and changes
nothing. When the card no longer holds, the run ends there and pushes nothing, and the card's
conversation offers its new status, Done or Dropped with the reason, for you to add. Otherwise the
plugin pushes an empty commit on the `agent/*` branch, never forced, and opens a draft pull request
with your `gh` login and the check in its body. That claims the card before any code. The same
session then does the work, and the plugin pushes it and gives the draft its title and body. It
never pushes anywhere else and never merges.

When the work needs a decision nobody made, the run stops and drafts it, and the card shows `Waiting
for a decision`. Add the decision on the board, which numbers it, then press **Go on with D-12**:
the same session goes on with that number. A reminder comes after a day, and after 7 days the run
fails. A run that fails before its work is done closes its draft, with a comment that says why, and
keeps the branch. The finished work drafts its changes to decisions and a card for each gap it
found. They wait in the conversation until you add them. The sandbox cannot listen on localhost, so
tests that need a server run only in CI, and the draft's body says which.

The plugin then watches the draft: when CI
fails, it conflicts, or you review it, the same background Claude session gets another round, at
most three. A review by anyone else waits for you: the card's conversation shows the comments, and
**Let the agent fix it** starts the round. A reply there asks for changes in your own words.
Watching goes on after the draft is marked ready, and stops when someone else pushes to it, or it
is closed or merged.

After you update the plugin, quit every Claude Code session and start new ones. A session that
keeps running can keep the old plugin's server.

To turn the agent off, choose **Put to sleep** under **Coding agents**, or type `/webchat:sleep` in
Claude Code. It finishes the cards and questions it runs, then takes no new ones in any window, new
ones included. Only `/webchat:wake` in Claude Code on the laptop wakes it.

The request and the agent's reports show in the card's conversation under **Coding agents**, where
you can stop a run. The card's status line tells your team: `Running: Ann's agent` while it
works, `Waiting for a decision` while it waits for one, `In review: repo#12` once its work is in the
draft, `Done in repo#12` or `Fixed in repo#12` once that is merged, and what it was before if the
run fails, the card no longer holds or the draft is closed without a merge. A card with an owner
runs only once its owner marked it ready. A merge also sets the decisions the work made true to
Accepted. A card that waits for a decision messages its owner. Your page writes these while it is
open. The agent reads the card as it is on the board,
whoever wrote it, and the board's decisions. It works with your git and GitHub credentials, so run
only cards you would do yourself.

### With the daemon

The daemon serves the same agent as the plugin, with the same sandbox and the same checks, from a
program you start instead of a Claude Code window. Today its only coding agent is Claude Code, so
the `claude` command must be installed and signed in on the laptop, but no window has to be open.
The plugin and the daemon keep separate accounts: never run both on one laptop for the same agent,
and pair each with its own code.

1. In WebChat, choose **Connect coding agent** and copy the code, as above.
2. In a copy of this repository, run `npm install`, then `npm run agent -- serve '<code>'`. Approve
   the agent in WebChat. It keeps its account in `~/.webchat/laptop`, so later you run only
   `npm run agent -- serve`.
3. Keep it running, in a terminal or as a launchd or systemd service, the way the plugin needs one
   window open. The agent is offline while the daemon is not.
4. In a folder you already have, run `npm run agent -- connect` to point the agent at it instead of
   cloning. `npm run agent -- sleep` and `npm run agent -- wake` do what `/webchat:sleep` and
   `/webchat:wake` do.

## Self-hosting instead

`npm run build && npm start` runs everything in one Node process on `PORT` (default 3000), with
PGlite or any Postgres in `DATABASE_URL`. Put it behind HTTPS (for example Caddy) and set
`TRUST_PROXY=1`. See [.env.example](.env.example) for every setting.

## Versions

WebChat follows [Semantic Versioning](https://semver.org). It is in early development, so every
version starts with 0, and any release may change how it runs. Each release has a tag such as
`v0.1.0` and a GitHub release, and `CHANGELOG.md` lists what it changed. Before you upgrade a server
you host yourself, read the breaking changes of each release you skip. They say what you must
change, such as a new setting. A Vercel deployment of main runs the newest code, which can be ahead
of the latest release.

## Tests

```bash
npm test
```

The integration test runs the app on a random port with an in-memory PGlite database and drives it
over HTTP, with every client doing real encryption. It checks that the database and pushes hold no
plain text, that a message the server alters is rejected, the one-time upgrade of old accounts, chat
keys, receipts, access control, and which browsers get a push while the recipient is looking,
looking away, or has closed the tab. A fake Apple push service checks that alerts to Bark carry no
text, that one provider token serves many of them, and that a phone Apple no longer knows is
forgotten. For projects it checks that channel keys must cover exactly the
members, that a person added later reads the earlier messages, and that replies and reactions stay
encrypted and reactions never count as unread. Any member of a group can add people, whose copy of
the key must come for exactly them, and who then read the earlier messages. Only the owner of a
project or group can remove people, delete it or hand it over, and only a project's owner deletes a
channel, never #general. Removing or leaving gives each chat a
new key for exactly the people who stay: the person who left cannot decrypt anything sent after, the
others and anyone added later read the history through the old key inside the new one, and nothing
is sent until the new key exists. The crypto tests cover wrong passwords, swapped keys, tampering,
forged senders, sharing a chat key with a newcomer, the old key inside a new one, and security
codes. The GitHub tests run against a fake GitHub: the sign-in's state and PKCE checks, the
encrypted token, which changes become alerts, the scheduler secret, a revoked token, and
disconnecting.

`npm run typecheck` checks the server, client, service worker, and tooling separately, since each
has its own environment.

## Project layout

```
api/      Vercel function entry point (wraps the Express app)
server/   Express API, Postgres queries, Web Push sender, alerts through Bark
client/   React app (Vite), the service worker (client/src/sw.ts), and the key store (client/src/e2ee)
shared/   Types and the end-to-end encryption code shared by server, client, and service worker
agent/    The coding agent's account, daemon (npm run agent) and Claude Code plugin server
plugin/   The Claude Code plugin: manifest, guard hook and connect skill, around agent/mcp.ts
test/     Integration tests (node:test)
scripts/  Icon generator (npm run icons) and the Vercel build skip for release commits
docs/     Decisions and roadmap, the source of truth for anyone changing the code
.github/  The Release Please workflow, which versions and tags releases
```

Before you change the code, read [AGENTS.md](AGENTS.md). It points to `.claude/rules/`, which
holds the constraints of each area of the code, to [docs/decisions.md](docs/decisions.md), which
records why the code is the way it is, and to [docs/roadmap.md](docs/roadmap.md), which lists
planned work, known issues and open questions.

## Limits

- It runs in Chrome and Edge 111, Firefox 114, and Safari 15.4 or later. On iPhone and iPad that
  means iOS 15.4, and push needs iOS 16.4.
- Text only: no voice or video calls, photos, or files yet. No typing indicator.
- With push turned off on a device, new messages show up on its next check-in (up to 3 seconds
  while you are looking, longer in the background).
- People can join a project or group later. Only the owner of a project or group can remove people
  or delete it, and an owner hands it over before leaving.
- After someone leaves, a chat takes no new messages until a member who stays has its new key. An
  open tab of any member makes it within seconds.
- Reactions never notify anyone. They show up at once in a chat that is open, and otherwise on the
  next check-in.
- Docs are Markdown only, and export only to PDF, through the browser's print dialog. Two people
  cannot edit the same section at once. A lock frees itself 2 minutes after its editor's tab stops
  checking in. Other people's edits show up on the next check-in, and nobody gets a notification.
  A section holds up to 10,000 characters.
- An alert through Bark cannot show the message text, and it cannot mark the message delivered.
  The delivered tick comes when the chat is opened. If Bark's author ever withdraws the published
  key, those alerts stop; nothing else is affected.
- Adding someone to a project or group needs a member whose browser can open every key in it. Up
  to 20 people can be added at a time.
- Pull requests show at most 30 per list, and only from github.com, not GitHub Enterprise Server.
  Changes show up on the next check, up to a few minutes later, not the moment they happen.
- One account per device counts each browser as a device. A browser that has signed in to an
  account cannot sign up for another for 400 days. A private window, another browser, or clearing
  the site's data gets around it.
