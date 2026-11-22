### D: Codex runs the owner's own setup and lists its models

Status: Proposed.

Codex now offers the `own` knob and a list of models, as Claude Code does (D-157, R-072). An
own-setup turn runs a bare `codex app-server` in the connected folder, so the owner's config,
hooks, MCP servers and environment load. Its `thread/start` names only the folder and the model
picked; the owner's config sets the sandbox and when Codex asks. Plan first sets the `read-only`
sandbox; Asks before it acts and Accepts edits leave it to their config. The models are what
Codex's own `model/list` shows, minus hidden ones, read once each time the agent looks for
harnesses, so a new release's model needs no change here. Why: the New chat greyed the switch to
the owner's own setup and offered only Codex's default model.

Cost: each look for harnesses starts a short-lived app-server. Codex lists no terminal sessions,
so Sessions from your terminal finds none for it.
