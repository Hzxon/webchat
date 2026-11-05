---
paths:
  - "server/api.ts"
  - "server/db.ts"
  - "server/bark.ts"
  - "server/apns.ts"
  - "client/src/chat.ts"
  - "client/src/docs.ts"
  - "client/src/docTemplates.ts"
  - "client/src/board.ts"
  - "client/src/components/**"
  - "agent/**"
  - "test/agent.test.ts"
  - "test/board.test.ts"
  - "test/channelName.test.ts"
---
# Projects, channels, groups, docs, the board and agents

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- Every project member is a member of every channel; there are no private channels (D-024).
- A new channel's key is wrapped for exactly the project's members at that moment; adding people brings every channel's current key wrapped for each of them, checked under the project's row lock (D-025).
- A stale view answers `409 stale_project` or `409 stale_group`; the page reloads and retries once, and shows a second conflict as an error (D-025, D-039, D-043).
- The member who adds people wraps its own opened copy of each key; each key holds the one it replaced so newcomers read history, and their read pointers start at the newest message (D-026, D-043).
- Adding people to a group: at most 20 at once; the server checks under the group's lock that the copies cover exactly those added, the key they came from is current and the adder is a member (D-043).
- Adding people to a project also checks under the lock that the adder is still a member (D-043).
- A group from before encryption with no key takes members without a key copy; its first message keys it for everyone (D-043).
- Channel names go through `toChannelName` and `isChannelName` in `shared/types.ts` on both sides: lowercase letters and digits in any script, single hyphens, at most 40 characters, unique per project (D-027, D-065).
- `toChannelName` applies NFKC first, cuts to the limit before trimming hyphens, and counts UTF-16 units like the server (D-065).
- Only the owner removes people, deletes or hands over; `projects.created_by` and `conversations.created_by` name the owner, the API calls it `ownerId`, and a group with no owner is open to any member (D-039, D-045).
- Only the owner deletes a channel, under the project's lock, and never #general: pages take the project's oldest channel for it, and its key opens the docs (D-081, D-096).
- Removal gives every chat in the project or group a new key for exactly those who stay, in the removing request (D-039, D-044).
- A project or group always has an owner among its members: the owner hands over before leaving, and the last member of a group deletes it (D-045).
- Of being added, removed, leaving and handing over, only being added sends a notification (D-031, D-039, D-045).
- Docs exist only in a channel, keyed by #general; a revision is sealed under the `webchat/doc/v1` header binding chat, key id, author, doc and section (D-081).
- A section save needs its `doc_locks` lock, which lapses 2 minutes after the last check-in; doc versions and held locks are in the sync fingerprint (D-081, D-021).
- A board is two docs marked by a `board` field inside the sealed title; a card's number, title and status come from its first two lines, in the `docs/decisions.md` format (D-082).
- A Bark push carries chat name, sender name, urgency and unread count, never message text; one APNs provider token is shared through the database and refreshed at most every 20 minutes (D-054).
- The Bark key comes from `BARK_APNS_KEY` and is never committed (D-054).
- An agent is a member account that never makes keys; it keeps its secrets in `~/.webchat/<name>/account.json` or the plugin's data folder, and two agents must not share that file, so the plugin keeps a copy per repository under `repos/`, each behind its own `watch.lock` (D-085, D-094).
- An agent's account comes only from pairing: the code stays in the page and the agent, the server sees its SHA-256 and HMAC proofs, and each side pins the keys the code proved (D-093).
- Run requests, reports and cancels are messages whose sealed `run` field names the card or the request's message id; a page folds only reports from the agent the request names, and an agent heeds only its owner's cancel (D-086, R-030).
- A card's run state comes from the user's run messages in #general; Run waits while one goes, and a done report moves the card to `In review` from the requester's page (D-100).
- A daemon runs a request only when its owner sent it, verified against the pinned keys, with a signed send time within 10 minutes of its own clock (D-089).
- An agent acts on a request's signed client id once; it remembers ids on disk while a copy could still run (K-47, D-093).
- An agent answers a second request for the card it is running with one failed report and starts nothing; a card is the board's doc and section, and a run that ended no longer counts (K-51, D-099).
- The plugin runs a request only in a session whose origin is the request's signed `repo`, and only while the background Claude's settings keep the secrets from its shell; a session says nothing on another repository's request. It refuses runs when origin's https address holds a login, which the shell could read from `.git` (D-093, D-094, D-097).
- A background Claude's turn fails after 2 hours with no output; the board stops waiting on a request no agent answers after 30 minutes (D-097, D-100).
- The plugin takes part only in a repository whose folder holds the `connected` mark, which only the `connect` tool writes; that tool keeps `requiresUserInteraction`, so the owner approves every call (D-101).
- The plugin's background Claude always runs `claude -p --restricted` with the plugin's `--settings` file, which keeps `sandbox.failIfUnavailable`, `permissions.blockReadsOutsideWorkingDirectories` and a `deny` for each credential variable: a plain `-p` run loads the repository's hooks and `.mcp.json`, an unavailable sandbox runs the shell unsandboxed, a sandboxed shell reads the macOS keychain, and it inherits every token in the environment, and Claude Code's `session-env` holds the SessionStart hooks' environment. Never set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` there: it makes every sandboxed command ask (D-097).
- Text a teammate wrote reaches the background Claude only on its stdin, never in its arguments, which `ps` shows (D-097).
- In the plugin only the server pushes: the run's `agent/*` branch, never forced, and it never merges. Its git in a worktree runs with hooks off, since the worktree's files are the model's (D-092).
- A daemon's run uses a worktree and a brief outside the repository; a plugin's worktree is under `.claude/worktrees`, where the sandboxed shell may write. A run never pushes to main and fails after 2 hours of silence or with no commits (D-087, D-092).
