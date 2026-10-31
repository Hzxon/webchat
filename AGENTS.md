# WebChat: start here

Read this file before you change anything in this repository, whether you are a person or an agent.
It is short on purpose. Two living documents hold the rest:

- [docs/decisions.md](docs/decisions.md) lists every decision that shapes the code, with its reason
  and its cost. Read the entries for the area you touch before you change how something works.
- [docs/roadmap.md](docs/roadmap.md) lists planned and deferred work, known issues, and open
  questions. Read it before you start new work, and pick from it when you are asked what to do next.

The [README](README.md) is for people who run WebChat. It explains the features, the encryption and
the deployment in user terms.

## What WebChat is

WebChat is an end-to-end encrypted web chat for college students who run several group projects at
once. It brings together what they otherwise spread over several apps:

- Chat in the style of WhatsApp: direct and group chats, replies, reactions, read ticks, urgent
  alerts, and push notifications.
- Projects in the style of Slack: a team with its own channels, starting with #general.
- Task tracking in the style of Jira: planned, not built yet. See the roadmap.

People who connect GitHub can also follow their pull requests in it. WebChat runs for free on
Vercel's Hobby plan with Supabase Postgres, or on any Node host with an embedded PGlite database.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies. The engines field pins Node 26. |
| `npm run dev` | Runs the API on port 3000 and the Vite client on port 5173, with PGlite in `data/pglite`. |
| `npm test` | Runs the integration and crypto tests with an in-memory database. |
| `npm run typecheck` | Checks the server, client, service worker and tooling, each with its own tsconfig. |
| `npm run build` | Typechecks, then builds the client, the service worker and the server. |
| `npm start` | Runs the built app in one Node process. |

The server log prints the invite code. Set `INVITE_CODE` to choose one. To test with two accounts in
one browser, open the app on two hosts, such as `alice.localhost` and `bob.localhost`. Each host
keeps its own cookies and keys.

## Map of the code

| Path | What lives there |
| --- | --- |
| `api/index.ts` | The Vercel function. It wraps the Express app. |
| `server/app.ts` | Builds the app from its parts: config, database, push, GitHub, routes. |
| `server/api.ts` | Every `/api` route, with input checks, sign-in checks and rate limits. |
| `server/db.ts` | The schema, the migrations, the sync fingerprint and every SQL query. |
| `server/notify.ts` | Decides who gets a push for a message, a reaction or a project invite. |
| `server/push.ts` | Sends Web Push with VAPID keys. |
| `server/github.ts` | The GitHub connector: OAuth, polling and pull request events. |
| `shared/types.ts` | Types shared by the server, the page and the service worker, and `LIMITS`. |
| `shared/e2ee.ts` | All end-to-end encryption, on Web Crypto only, for the page, the service worker and the tests. |
| `client/src/chat.ts` | The sync loop, sending, projects and reactions. It decrypts on the way in. |
| `client/src/store.ts` | The page's state and the actions that change it. |
| `client/src/e2ee/` | The page's keyring and its IndexedDB key store. |
| `client/src/sw.ts` | The service worker. It decrypts pushed messages and shows notifications. |
| `client/src/components/` | The React views. |
| `test/` | Integration tests that drive the real app over HTTP, and crypto tests. |

## Rules that must hold

These rules protect the product's promises. Breaking one is a bug even when every test passes. The
decision behind each rule explains why it exists.

1. The server never sees what users write. Text, quotes, reaction emoji and any future content are
   encrypted and signed in the browser. When a change makes new data visible to the server, list it
   in the README section "What it does not protect against". See D-014 and D-020.
2. Bind into the signature every field that the server could change and the client relies on. Add a
   new field so that old messages still verify, the way `kind` was added. See D-016.
3. Migrations only grow at the end. Add a new entry to `MIGRATIONS` in `server/db.ts`. Never edit,
   reorder or renumber an entry that has reached main. See D-010.
4. No connection stays open. Pages learn about changes from `POST /api/sync` and from Web Push. Any
   new state that pages must see has to change the sync fingerprint in `db.stamp`. See D-004 and
   D-021.
5. A chat key goes to exactly the chat's members. For channels, the server checks this while the
   project is locked. See D-015 and D-025.
6. Read query strings with the WHATWG URL API, never with `req.query`. See D-012.
7. A push payload is at most 3,000 bytes and never holds the plain text of encrypted content. See
   D-017.
8. The GitHub token never reaches the browser. See D-033.

## How to work here

- Start from the latest main. Open a pull request. Main is squash-merged, and the squash commit's
  subject is the pull request title followed by "(#N)".
- Write commit messages as Conventional Commits. The subject has at most 50 characters, capitalizes
  the first word after the type, uses the imperative and has no final period. The body explains what
  changed and why, wrapped at 72 characters. Never add AI attribution, such as a `Co-Authored-By`
  line for an AI or a "Generated with" line.
- Before you open a pull request, run `npm run typecheck`, `npm test` and `npm run build`. For a
  change people can see, also try it in a browser with two accounts, at desktop width and at 375
  pixels, in light and dark mode.
- Write documentation in short, plain sentences with one idea each, like the README. Code comments
  explain why the code is the way it is, not what it does.

## Keep these documents alive

These files are the source of truth only while they stay current. Update them in the same pull
request as the change they describe.

- When you make a decision, add it to `docs/decisions.md`. A decision is a new pattern, a trade-off,
  a limit, a dependency, or a rule. When it replaces an older decision, mark the old one as
  superseded and link the new one.
- When you start, finish or set aside work, update its entry in `docs/roadmap.md`. When you find a
  gap or a bug you are not fixing, add it there.
- When you change a command, a path or a rule in this file, update this file.
- When a document and the code disagree, the code is what runs. Fix the document, or record the bug
  in the roadmap.
