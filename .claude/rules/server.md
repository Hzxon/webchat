---
paths:
  - "server/**"
  - "api/**"
  - "shared/types.ts"
  - "test/api.test.ts"
  - "test/chat.test.ts"
  - "test/sql.test.ts"
---
# Server, database and sync

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it. Encryption, GitHub and projects have their own files.

- Never hold a connection open; pages learn of changes through `POST /api/sync` and Web Push (D-004).
- Any new state that pages must see must change the `db.stamp` string; add it to its query (D-021).
- Hash owners in the fingerprint, never sum them, so two handovers cannot cancel out (D-021).
- A route runs inside the shared 30-second `maxDuration`; work after the response goes through `waitUntil` (D-005).
- Put every table in the `webchat` schema, never `public` (D-006).
- Every query must run on both PGlite and Postgres; PGlite takes one statement per query (D-006).
- Import PGlite through a computed module name so the bundler leaves it out of the function (D-006).
- Add schema changes only as a new file `server/migrations/NN-name.sql` with the next number; never edit, reorder or renumber one (D-010, D-106).
- `test/rules.test.ts` hashes the SQL of every migration file; a new one appends the line the failing test prints (D-091).
- Each migration runs once, in order, in a transaction under an advisory lock (D-010).
- When two branches add a migration, the one that reaches main first keeps its number (D-010).
- Sizes the server enforces and the page respects live in `LIMITS` in `shared/types.ts`; raising one may need a larger JSON body limit in `server/app.ts` (D-011).
- A body over the limit, or not JSON, gets a JSON error the page can show (D-011).
- Read query strings with the WHATWG URL API or `queryOf`, never `req.query` (D-012).
- Every API request names its account in `x-webchat-user`; a mismatch answers `409 account_changed` (D-008).
- Attention lasts 45 seconds after the last check-in; a closing tab ends it with `POST /api/away` (D-007).
- A tab with no push subscription gets no push and checks in every 3 seconds (D-007).
- A push endpoint moves to another account only when the subscribe request holds its stored keys; the endpoint alone is not proof.
- Every `/api` response carries `X-WebChat-Build`; send none without a built page (D-040).
- Count a sign-in attempt before it runs and return the hit with `returnRateLimit` before answering; never use the `finish` event, the function may stop after the answer (D-068).
- Sign-up refuses a browser that sends the `webchat_device` cookie; sign-up, sign-in and sign-out set it (D-080).
- Account deletion goes through the leave path so chat keys rotate; keep the `users` row with `deleted_at`, and treat a deleted id as "Person not found" wherever someone would key a chat for it (D-088).
- `DELETE /api/auth/account` refuses with `owner` while the person owns a project or group with others (D-088).
- A read or delivered pointer never moves past the chat's newest event, and the fingerprint sums pointers as BIGINT (D-022).
- Reactions cannot be urgent; the server refuses an urgent reaction rather than changing it (D-023, D-030).
- The server sends no push to a Safari endpoint while the user looks, except urgent ones; `showsEveryPush` identifies Safari by Apple's push host (D-047).
- A check-in answers `more: true` with an empty fingerprint when the newest message id is past its cursor; `GET /api/bootstrap` reads the fingerprint before anything else (D-048).
- A route answers JSON or 204 (D-056).
- (chat, sender, client id) is unique in `webchat.messages`; a repeat returns the stored message with 200 and sends no push (D-061).
- A `GET /api/urgent/ring` call runs only while an unread urgent message exists; urgent pushes carry a `Topic` header from the hashed tag; a Bark alert for an urgent message is critical (D-079).
- `conversations.last_event_id` follows reactions, `last_message_id` does not (D-030).
- A reaction push only wakes a tab the recipient is looking at and notifies nobody; a reaction push tag is `reaction-` plus the chat id (D-030, D-070).
- Project and group invite pushes show even while the app is open; the server writes the project invite text, since project names are not encrypted (D-031, D-043).
- Everyone on a deployment sees every other member's name and online status; sign-up needs the invite code from `INVITE_CODE` (D-002).
- `/api/pairings` creates and reads with no sign-in and holds only public keys and proofs; a read answers 204 until the agent's half exists; approving needs the owner's session (D-093).
- Deleting an account deletes the agents it owns, in the same transaction (D-093).
- A check-in names repositories, never a path: a laptop's names every folder and sets the agent's `protocol`, each repository named updates its row of `agent_repos`, and a laptop's drops the rows it no longer names; the sync fingerprint covers both (D-094).
- A new chat is inserted with the id its first key names, which only the person it was reserved for may use, once; a channel's id must be above #general's (D-111).
- `DELETE /api/agents/:id` lets only the agent's owner remove it: it is deleted as an account is, and loses its owner, so no menu offers it (R-033).
