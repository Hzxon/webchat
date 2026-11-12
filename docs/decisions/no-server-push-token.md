### D: The server never holds a user's GitHub access

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-gh-token.md).

A card run pushes and opens drafts with a GitHub login on the owner's laptop, never with a token
the server issues. The GitHub App keeps reading pull requests only, and the server keeps none of
its tokens (D-050). This answers docs/roadmap/new-gh-token.md: no. Why: an installation token
would let WebChat's server push to every repository the App is on, and make it answer for users'
GitHub accounts.

Cost: a GitHub login stays on every laptop that runs cards: the agent's own, in the locked room.
