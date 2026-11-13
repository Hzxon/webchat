### K: The board does not show the proposals that wait for it

Status: Open. Found by the owner on 2026-11-13, who looked on the board for the drafts and found none.

A proposal file on main reaches the owner as a card draft (D-117). The draft and its button sit in a
thread under Chats, in the row "Coding agents", named `Proposed in <repo>: <file>`. The board says
nothing about them. On 2026-11-13 main held 37 such files, and the linked board showed Ready 4,
Running 0 and In review 1, with no sign that 37 cards and changes waited for the owner's go. The
board is the source (D-117), so an owner looks there first, finds nothing, and takes the board for
stale. The row's name also says nothing of board work.

Fix: the board of a linked repository shows how many proposals wait, such as "37 proposals wait",
to the owner only, since only they hold the drafts. A click opens the agent pane on those threads.
The owner still approves each draft with its button (D-104). Nothing new reaches the server: the
page counts the threads it already has.

Done when: with a proposal draft not yet added, the owner's board shows the count and a click opens
its thread; the count drops when the draft is added; a teammate's board shows no count; and a board
with no linked repository shows none.
