### D: CI runs on the owner's own server

Status: Proposed 2026-11-13 in #211.

The checks, the id checks and Release Please run on a self-hosted GitHub Actions runner, labelled
`self-hosted` and `linux`, on a Linux server of the owner's. A self-hosted runner uses none of the
account's Actions minutes, which ran out on the private repository. The agent's release builds stay
on GitHub's machines, one per OS and processor, since the server is one of them at most. The locked
room's real-room job runs on Linux only, on that server, with passwordless sudo; its macOS leg is
dropped.

Cost: CI waits while the server is down, and the one runner takes one job at a time. The server
runs whatever a pull request's branch holds, as root for the room job, so it holds nothing else of
value. macOS's room is checked only by unit tests and by hand. A release still needs GitHub's
minutes for its four builds.
