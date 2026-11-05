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
- Removal gives every chat in the project or group a new key for exactly those who stay, in the removing request (D-039, D-044).
- A project or group always has an owner among its members: the owner hands over before leaving, and the last member of a group deletes it (D-045).
- Of being added, removed, leaving and handing over, only being added sends a notification (D-031, D-039, D-045).
- Docs exist only in a channel, keyed by #general; a revision is sealed under the `webchat/doc/v1` header binding chat, key id, author, doc and section (D-081).
- A section save needs its `doc_locks` lock, which lapses 2 minutes after the last check-in; doc versions and held locks are in the sync fingerprint (D-081, D-021).
- A board is two docs marked by a `board` field inside the sealed title; a card's number, title and status come from its first two lines, in the `docs/decisions.md` format (D-082).
- A Bark push carries chat name, sender name, urgency and unread count, never message text; one APNs provider token is shared through the database and refreshed at most every 20 minutes (D-054).
- The Bark key comes from `BARK_APNS_KEY` and is never committed (D-054).
- An agent daemon is a member account that never makes keys; it keeps its secrets in `~/.webchat/<name>/account.json`, and two daemons must not share that file (D-085).
- Run requests and reports are messages whose sealed `run` field names the card or the request's message id; a page folds only reports from the agent the request names (D-086).
- A daemon runs a request only when its owner sent it, verified against the pinned keys, with a signed send time within 10 minutes of its own clock (D-089).
- A run uses a worktree and a brief outside the repository, never pushes to main, and fails after 2 hours of silence or with no commits (D-087).
