### R: Finish the parts of the agents window that need the agent

Status: Idea. Proposed 2026-11-22 with the agents window redesign (#298).

Why: the agents window design (the Claude Design canvas, artboards Main and ModelPicker) shows
four controls that the page cannot drive today. The agent has no message for them, so #298 left
them out instead of showing controls that do nothing.

Scope:

- A folder browser for Add folder: done another way. Choose folder sends the owner's signed
  `pick`, and the runner opens the laptop's own folder window (Finder, or zenity on Linux). The
  folder picked files a connect request, which the owner still approves
  (docs/decisions/connect-approval.md). It needs someone at the laptop.
- New folder by cloning: the owner clones a project's repository on a laptop from Add folder,
  without a run or a question waiting for it. Today `askClone` needs one.
- Effort for a session's model, as the picker's third column shows it: a signed `effort` field
  on `prompt` and `reply`, which the harness adapters pass on where the harness takes one. Until
  then the picker's third column holds the permission mode.
- Switching a running session between the owner's own setup and restricted. A session's setup
  is fixed when it starts (D-157), and a card run is always restricted, so this needs a decision
  first.

Done when: each of the four works from the window, signed where it changes what runs, and the
rules files name the new fields.
