---
paths:
  - ".github/**"
  - "scripts/**"
  - "docs/**"
  - "package.json"
  - "vercel.json"
  - "vite.config.ts"
  - "tsconfig*.json"
  - "client/tsconfig*.json"
  - "server/tsconfig*.json"
---
# Process, release and tooling

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it. The process itself is in AGENTS.md.

- `scripts/claim.sh` takes the decision number as a third argument, refuses one an open pull request reserves, and takes it by pushing the tag `reserve/D-xxx`, which the remote creates only once; never delete or force such a tag (D-076).
- Before a claim, check that the item is still open on main, that no decision since settles it, and that no other entry or pull request covers it; `scripts/claim.sh -c` records the check and refuses a finished item (D-107).
- An item that no longer holds gets a small pull request that sets its status in place, never a claim (D-107).
- A pull request that finishes a roadmap item edits only that item's status line, in place; a housekeeping pull request deletes the entry and adds its Done row (D-076).
- New decision entries go at the end of their topic section; `.gitattributes` merges `docs/decisions.md` with the union driver, so entries are never deleted (D-076).
- Never use the union driver for `docs/roadmap.md`, where entries move (D-076).
- A new roadmap entry is one file under `docs/roadmap/`, named by its id; only a housekeeping pull request folds it into `docs/roadmap.md` (D-106).
- A stacked branch runs `scripts/restack.sh <parent>` when its parent lands; it never merges main (D-106).
- A decision entry is the current state, why and the cost, in at most 12 lines; a change rewrites it (D-090).
- A constraint that people editing an area must hold gets one line in that area's file under `.claude/rules/` (D-090).
- The `doc-ids` check fails duplicate `### D-0xx:`, `K-n`, `R-nnn` and `Q-n` headings; the later pull request renumbers (D-063).
- CI runs typecheck, tests and build, and `doc-ids` its id check, on pull requests and on main. Main has no branch protection and no merge queue, so nothing checks a pull request again after main moves (D-076).
- The pull request title type sets the version: `fix` patch, `feat` minor, `!` or `BREAKING CHANGE:` also minor below 1.0.0 (D-055).
- Never edit the version or `CHANGELOG.md` by hand; Release Please owns them, and needs "Allow GitHub Actions to create and approve pull requests" on (D-055).
- Only Release Please may title a commit `chore(main): Release `; the ignore script skips it (D-058).
- The Claude Code plugin ships from the `plugin` branch, which the release job builds from the tag; Release Please sets `plugin/.claude-plugin/plugin.json`'s version (D-092).
- A file under `docs/`, `test/`, `.github/`, `scripts/`, `agent/` or `plugin/`, or any Markdown, never ships; move a file the app reads at runtime out first (D-058).
- Only main deploys from Git: keep `git.deploymentEnabled` and the Vercel Ignored Build Step (D-041).
- The function runs in `sin1` (`vercel.json`), the same region as the database (D-003).
- Hobby cron runs once a day, so nothing may depend on finer cron timing (D-003, D-034).
- `engines` pins Node 26.x; changing it also changes the README requirement (D-013).
- `tsconfig.json` keeps `typeRoots` spelled out for Vercel's temporary tsconfig (D-013).
- `allowScripts` in `package.json` keeps denying esbuild and fsevents install scripts (D-013).
- `browserTargets` in `vite.config.ts` keeps iOS 15.4 as the floor; raising it also changes the README line (D-052).
- Change the CSP in `vercel.json` and `server/app.ts` together; keep the service worker at `Cache-Control: no-cache` (D-009).
- Tests in `test/chat.test.ts` run in order and share state (D-036).
- Changes people see are tried with two accounts, at desktop and 375 pixels, in light and dark mode (D-037).
- Rules 3, 6, 7 and 8 of AGENTS.md have a test; `test/rules.test.ts` checks migrations and `req.query`, `test/chat.test.ts` the push payload, `test/github.test.ts` the GitHub token (D-091).
- A new migration appends one line to `FROZEN_MIGRATIONS` in `test/rules.test.ts`, which the failing test prints; never change or remove a line there. The hash covers the SQL without comments, so a comment may change (D-091).
- A new test that sends from Alice in `test/chat.test.ts` may hit her 30 sends per 10 seconds; clear the `send:` rate limit rows after it, as the push payload test does (D-091).
