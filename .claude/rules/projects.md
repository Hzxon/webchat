---
paths:
  - "server/api.ts"
  - "server/db.ts"
  - "client/src/chat.ts"
  - "client/src/components/**"
  - "test/channelName.test.ts"
---
# Projects, channels and groups

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- Every project member is a member of every channel; there are no private channels (D-024).
- A new channel's key is wrapped for exactly the project's members at that moment, by someone still among them; adding people brings every channel's current key wrapped for each of them, checked under the project's row lock (D-025).
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
- Only a person owns a project or group, never an agent: the dialog offers no "Make owner" for one and the server refuses it (D-114).
- Of being added, removed, leaving and handing over, only being added sends a notification (D-031, D-039, D-045).
