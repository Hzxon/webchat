### D: The agent installs with one line from GitHub releases

Status: Proposed 2026-11-12 in #193 (docs/roadmap/new-agent-build.md).

The Connect dialog shows one line for the server's own release. The script and a single file per
OS and processor, with Node inside, come from that GitHub release and are checked against its
checksums, never served by WebChat. Setup checks read-only first, then asks once: a summary, the
harnesses to link, the password. It adds only what the agent needs, git through the package
manager and a checked `gh` for `_webchat`, offers a missing harness's own installer and never
changes a security setting. A laptop without admin rights is not supported. A root-owned updater
follows the server's release, forward only. `doctor` reruns the checks. Why: one line, one
password and two approvals in the browser.

Cost: four builds in every release. A tampered server could show a different line, as it could
change the page (README). Going back to an older release takes running the line again.
