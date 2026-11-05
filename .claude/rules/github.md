---
paths:
  - "server/github.ts"
  - "server/githubApp.ts"
  - "shared/github.ts"
  - "client/src/github.ts"
  - "test/github.test.ts"
---
# GitHub connector and GitHub App

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- The GitHub token never reaches the browser; it is stored AES-256-GCM encrypted under a key derived from `GITHUB_CLIENT_SECRET` (D-033).
- Disconnecting GitHub deletes the token and revokes the grant on GitHub (D-033).
- GitHub linking never replaces the password sign-in; the encryption keys come from the password (D-032).
- The connector stays hidden until `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set (D-032).
- Polls of one account are at least 60 seconds apart for tabs, 10 for a refresh, 55 for scheduled runs (D-034).
- One poll pushes at most three events, the most important ones (D-034).
- Each list shows at most 30 pull requests, from github.com only (D-034).
- `GET /api/github/poll` requires `CRON_SECRET`, or on Vercel the bearer secret in `webchat.meta` (D-034, D-057).
- The pg_cron job `webchat-github-poll` is created at start, left alone when one exists, and reads its secret at run time (D-057).
- `pollAll` records its start; the "alerts with every tab closed" promise holds only while the last run is under 10 minutes old (D-057).
- A shared pull request card rides in the encrypted `pull` field of a normal message; the page rebuilds its link and drops the card if it differs (D-042).
- Cards the server writes are kind "github", have no sender, carry plain JSON and show "Not encrypted"; pages rebuild their link from repository and number (D-050).
- A repository link is accepted only from the owner's app sign-in listing, within half an hour, and that token is revoked at once (D-050).
- Do not query a team's review request without `read:org`; GitHub refuses the whole poll (D-050).
- `graphql` returns errors next to data; `hiddenOrganizations` reads FORBIDDEN error text, so a reworded GitHub message breaks the banner (D-060).
