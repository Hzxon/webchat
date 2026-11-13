### R: Run ACP agents from a shipped list through one adapter

Status: Done in #203. Proposed 2026-11-12 from the agent host design. The shipped list is empty until
an agent has been run for real (docs/decisions/acp-adapter.md).

Order: after docs/roadmap/new-harness-linking.md. It replaces "ACP waits for a third harness" in
docs/roadmap/new-codex-adapter.md.

Why: every harness needs its own adapter today. Agents that speak the Agent Client Protocol could
share one, so a team on another coding agent can link it.

Scope: a list shipped with the daemon names each supported ACP agent, its command and its minimum
version. One adapter starts an agent per session, hands it a `submit_answer` MCP tool whose input
is the turn's JSON answer, reads progress from its updates, and answers its permission requests by
WebChat's rulebook or, with docs/roadmap/new-harness-approvals.md, asks the owner. Hermes is the
first agent to consider (docs/roadmap/new-hermes-harness.md).

Constraints: an agent not on the list is never run. Check the ACP method names against the spec
before building: permission requests, MCP servers passed to a new session, and the file and
terminal methods.

Done when: an ACP agent from the list answers a question and ends its turn through `submit_answer`;
one not on the list cannot be linked.
