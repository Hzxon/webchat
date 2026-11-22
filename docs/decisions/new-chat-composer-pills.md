### D: The chat composer and bubbles are rounded

Status: Proposed 2026-11-22 in #295.

The chat pane follows the new design. The message box is a pill with a round attach button and a
round Send, and "Mark as urgent" is a pill above it that turns soft red when on. Message bubbles
have 12px corners, with a 4px corner where a run of messages starts, and the time floats at the
end of the last line. These are the only corners in the chat pane that skip the 6px `--radius` of
D-083. A round box reads as the one place to type, as in the phone chat apps students know.

Cost: an exception to "every corner uses `--radius`", which D-083 and `.claude/rules/client.md`
now name.
