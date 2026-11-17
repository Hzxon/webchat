---
paths:
  - "server/bark.ts"
  - "server/apns.ts"
  - "server/db.ts"
---
# Bark push

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- A Bark push carries chat name, sender name, urgency and unread count, never message text; one APNs provider token is shared through the database and refreshed at most every 20 minutes (D-054).
- The Bark key comes from `BARK_APNS_KEY` and is never committed (D-054).
