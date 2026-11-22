### R: Finish the parts of the agents window that need the agent

Status: Idea. Proposed 2026-11-22 with the agents window redesign (#298).

Why: the agents window design (the Claude Design canvas, artboards Main and ModelPicker) shows
four controls that the page cannot drive today. The agent has no message for them, so #298 left
them out instead of showing controls that do nothing.

Scope:

- A folder browser for Add folder: the owner picks a git copy of a project's repository on one
  of their laptops, like Finder. The agent lists a laptop's folders on its owner's signed ask, and
  only under the home folder. Picking a folder approves the connect, as `webchat-agent connect`
  does now (docs/decisions/connect-approval.md).
- New folder by cloning: the owner clones a project's repository on a laptop from Add folder,
  without a run or a question waiting for it. Today `askClone` needs one.
- Effort for a session's model, as the picker's third column shows it: a signed `effort` field
  on `prompt` and `reply`, which the harness adapters pass on where the harness takes one. The
  permission mode moved to the shield under the ask box (docs/decisions/new-setup-switch.md).
- Switching a running session between the owner's own setup and restricted: done by a hand over
  to the same harness (docs/decisions/new-setup-switch.md).

Done when: each of the four works from the window, signed where it changes what runs, and the
rules files name the new fields.
