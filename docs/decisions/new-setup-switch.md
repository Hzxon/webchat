### D: A session switches setup by a hand over, and Auto is the default mode

Status: Proposed.

The shield under the ask box opens a menu. It picks where a session runs, restricted by WebChat or
in the owner's own setup, and the permission mode in their own setup. A running session switches
setup by a hand over to the same harness (D-156). The reply's signed `handover.own` names the
setup. The session writes a summary, the owner reads it and may edit it, and a new session starts
from it in the other setup. This replaces D-157's rule that a session's setup is fixed when it
starts. The permission mode moved out of the model picker to the shield. Auto, Claude Code's
`--permission-mode auto`, is the new default; Codex leaves it to the owner's config. Why: a
restricted session sits in a scratch copy and an own one in the folder, so neither can resume the
other's session. Cost: a switch loses what the summary leaves out.
