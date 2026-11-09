### Q: Should a card run stop needing the owner's gh token?

Status: Open. Raised 2026-11-09 by the harness audit.

Order: answer it before the Codex card's second half, which sets the isolation bar a weak
harness must clear to take cards. Nothing else waits on it.

WebChat has a GitHub App (D-033). If the plugin pushed and opened drafts with a short-lived
installation token fetched from the server instead of the owner's `gh` login, the biggest secret
on the laptop would be gone, and every harness could take cards without proving a deny-read
sandbox (D-097). Against it: a new trust path from the server to the laptop, the server would
know when a run pushes, and rule 8 of AGENTS.md was written for the browser, not the plugin.
The owner must weigh the trust path against the isolation bar before the Codex adapter card
decides what a weak harness may do.
