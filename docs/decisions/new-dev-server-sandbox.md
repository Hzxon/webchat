### D: The runner starts a run's dev server in a sandbox it owns, and a browser reaches only that

Status: Proposed 2026-11-14 in #235 (R-046).

On macOS, a Claude Code turn that can ask the owner gets the browser `chrome-devtools-mcp` (pinned
and installed root-owned by setup, never fetched by a run) and WebChat's `dev_server` tool. The
runner starts the dev server under a Seatbelt profile of WebChat's own (`devProfile` in
`agent/browser.ts`). The profile lets it bind and reach only two ports the runner picked, which it
gets as `PORT` and `PORT_2`. It writes only the working folder and a temp folder of its own. It
reads no file under a home folder, a volume or a temp folder but those two and the `node` on PATH's
folder, as the shell reads only its working folders, and no secret folder. It has no DNS, no Mach
service and no signal outside the sandbox. Chrome runs headless on a temporary profile, and every
request goes through a proxy in the runner that passes only those ports on `localhost` names. The
rulebook allows only a named list of the browser's tools, `url`s on those ports, and paths in the
working folders. The model's shell keeps only the npm registry (D-097).

Why: Claude Code's `allowLocalBinding` opens every loopback port on macOS and does nothing on
Linux, and a dev server is the model's code, which must not run as a plain process of the owner.
This revisits docs/decisions/new-sandbox-owned.md for the dev server alone. Linux has no browser
yet: it needs a network namespace that the dev server and Chrome share.

Cost: a sandbox WebChat owns, on `sandbox-exec`, which Apple marks deprecated. A toolchain kept in
the home folder other than `node`'s does not run there. The ports are free when picked, so another
local program could take one first, and the browser would reach it. chrome-devtools-mcp runs
outside every sandbox, as any local MCP server does, so its tool list and path checks carry the
weight. A release that changes the pin needs setup again.
