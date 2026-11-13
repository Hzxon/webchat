### R: Link harnesses from the list WebChat supports

Status: Done in #201.

Order: second, beside docs/roadmap/new-agent-setup.md.

Why: the plugin offers Codex only when it is on the PATH, the daemon offers Claude Code only, and
the owner turns harnesses off instead of choosing them (docs/decisions/new-harness-pick.md). A
harness found on the laptop runs without the owner ever saying so.

Scope:

- The runner finds the supported harnesses on the PATH saved at setup and in the usual install
  folders, every minute and on `doctor`. Supported means a built-in adapter: Claude Code and Codex.
- Setup lists those it found, and the owner picks which to link, signed-in ones ticked. The picks
  ride the pairing, and the approval dialog shows them.
- Settings shows one row per supported harness, with its path and version: linked, linked but
  needing attention, found but not linked, or not found. Link and Unlink are signed setup choices.
- `webchat-agent link <name>` sends a request the owner approves on the page. An unsupported name
  fails with the supported list.
- The daemon offers Codex too. A request with no pick runs on the first linked harness.

Constraints: the sealed setup choice gains `linked`; a page from before still writes `off`, which
the agent keeps reading. An adapter may declare a minimum version. The check-in's level is the
union over linked harnesses, and the server learns no harness name (D-115).

Done when: on a laptop with both harnesses, linking only Claude Code fails a Codex request with the
reason; linking Codex in Settings makes it run; `webchat-agent link hermes` fails with the list; a
test covers each row state.
