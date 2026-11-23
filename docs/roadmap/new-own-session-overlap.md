### R: A session in its owner's own setup warns when its changes overlap a draft

Status: Running.

A member who starts a session in their own setup (D-157) works in their connected folder, with
their own harness. That session claims nothing and opens no draft, so neither the overlap check
(#260) nor the run's overlap gate (#276) sees what it changes. Two teammates' agents can then edit
the same files, and the clash shows only when the second one pushes.

After each turn of such a session, the agent reads the files the folder changes: what its branch
committed since it left the default branch, and what is not committed yet. It compares them with
the open pull requests by `shared/overlap.ts`, the rule the gate uses. A file an open pull request
on another branch also changes gets a note under the answer, naming the pull request, its card and
the files. The note blocks nothing: WebChat does not control a harness in its owner's setup.

Done when an own-setup turn in a connected folder that changes a file an open draft holds ends with
that note, and a turn that shares no file has none.
