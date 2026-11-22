### D: The chat composer is rounded

Status: Proposed 2026-11-22 in #295.

The chat composer follows the new design: the message box is a pill with a round attach button
and a round Send, and "Mark as urgent" is a pill above it that turns soft red when on. These are
the only corners in the chat pane that skip the 6px `--radius` of D-083. A round control reads as
the one place to type, as in the phone chat apps students know. Turned on, urgent shows in the
pill's own color and in a small red "Urgent" label with a thin red edge on the bubble, as before.

Cost: one exception to "every corner uses `--radius`", which `.claude/rules/client.md` states,
so that line should name the composer once this is added.
