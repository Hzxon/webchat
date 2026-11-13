### D: CI runs on the owner's own machines

Status: Proposed 2026-11-13 in #211, changed in #213 and in this pull request.

The checks and the id checks run on either of two self-hosted GitHub Actions runners: a Linux server
of the owner's (`self-hosted`, `linux`) and the owner's Mac (`self-hosted`, `macOS`). Release Please
runs on the Linux server only. A newer push to a pull request cancels its older CI and id-check
runs, so they free their runner. A newer push to main cancels main's older CI run the same way, so
a burst of merges tests only the newest commit, and finding the merge that broke main takes a
bisect. A self-hosted runner uses none of the account's Actions minutes,
which ran out on the private repository. The agent's release builds stay on GitHub's machines, one
per OS and processor. The locked room's real-room job runs on Linux only, on that server, with
passwordless sudo; its macOS leg is dropped.

Cost: each runner takes one job at a time, and CI waits while both are down. A runner runs whatever
a pull request's branch holds. The server holds nothing else of value, but the Mac runs jobs as the
owner, with their files and keys in reach. macOS's room is checked only by unit tests and by hand.
A release still needs GitHub's minutes for its four builds.
