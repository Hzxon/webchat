### D: A run sends its screenshots to its owner as photos, checked and capped by the keyholder

Status: Proposed 2026-11-14 in #240 (R-046).

A Claude Code run with a lab gets WebChat's `send_screenshot` tool, beside `dev_server`: a PNG in
the working folder and a caption. The runner judges the path, refuses a file over 10 MB by its size,
and puts the bytes to the keyholder on a side connection, as a bundle goes: an `upload` gives a
transfer id, good once, for 10 minutes and at most 10 MB, and a `shot` names it, for a live turn.
The keyholder checks the bytes as data: a PNG by its first bytes, its IHDR at most 1600 pixels on
the longer side, at most 12 a run, in memory. It encrypts and uploads the file as a page does
(D-123) and sends an ordinary message with the `file` field, in the owner's direct chat, one at a
time and 400 ms apart. A card run's message carries a `run` report of kind `note`, which changes no
state; a question's carries `prompt` of kind `note`. The model reads a fixed sentence for each
refusal, never the server's error.

Why: the runner may read the file but holds no key; the keyholder holds the keys but may not read
the owner's folders (docs/decisions/locked-room.md). The agent cannot resize, so the model takes
screenshots at device scale 1. A model in a loop must not spend the account's 450 uploads a month.

Cost: the server sees one upload per screenshot, its size and its chat (D-020, D-123). An older
page drops a `note` report, so it shows no screenshot. A screenshot over 1600 pixels is refused,
not shrunk.
