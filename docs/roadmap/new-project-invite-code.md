### Q: Can a project have its own invite code?

Status: Idea

Why: the new design's member settings show an invite code for the project, with New code and Copy.
The project switcher offers Join with an invite code, and the Members menu offers Copy invite link.
The app frame pull request leaves all three out, because nothing behind them exists yet.

What stands in the way: a deployment has one invite code, for signing up, and everyone on it can
already find everyone else (D-002). Joining a project is not something a newcomer can do alone.
Someone already in the project must wrap every channel's key for them under the project's lock
(D-025, D-026), and only a member's browser holds those keys. So a code cannot let someone in by
itself. At most it could ask to join, and a member online would then let them in.

The question: is "ask to join, a member approves" worth a server change, a migration and a new
place where a request waits? Or does Add Member, which already finds anyone on the deployment,
cover it, so the design drops the code?

Done when the owner picks one, and the design or a new R-item follows.
