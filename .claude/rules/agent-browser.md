---
paths:
  - "agent/**"
  - "test/agent*.ts"
---
# A run's browser and screenshots

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- A run's dev server starts only through WebChat's `dev_server` tool, in the runner, under `devProfile` (`agent/browser.ts`): it binds and reaches only the lab's two ports, writes only the working folder and the lab's temp folder, reads file contents under a home folder, `/Volumes` or a temp folder only in those two and the `node` on PATH's folder (the tool returns its output to the model), reads no secret folder, and gets no DNS, Mach service or signal outside the sandbox; it never runs as a plain process of the owner, and it ends with the turn. Seatbelt matches a socket's path as given and a `unix-socket` filter takes one path, so give real paths, one rule per folder (docs/decisions/new-dev-server-sandbox.md).
- Chrome comes only from chrome-devtools-mcp launching it, never `--browserUrl`, `--wsEndpoint` or `--autoConnect`: headless, `--isolated`, statistics, CrUX, update checks, config discovery and `file:` navigation off, and every request through the lab's proxy with loopback not bypassed, which passes only `onRunPort` addresses (docs/decisions/new-dev-server-sandbox.md).
- `judge` allows a browser tool only from `BROWSER_TOOLS`, by name, and only with a lab; add a tool there only after reading its arguments. `claudeAsk` judges every argument whose name ends in `path` or `paths` as a path, and a `url` passes only through `onRunPort` (docs/decisions/new-dev-server-sandbox.md).
- chrome-devtools-mcp is pinned in `agent/browser.ts` by version and SHA-256, with the same exact version in package.json; setup installs it root-owned in the program folder and a run never fetches it. The single file runs it with `webchat-agent browser`, through `vm`'s main-context loader, since a single executable cannot `import()` a file (docs/decisions/new-dev-server-sandbox.md).
- A run's screenshot reaches the owner only through `send_screenshot`, with a lab: the runner judges the path and puts the bytes on a side connection (`upload`, then `shot`, for a live turn, at most `LIMITS.fileBytes`); the keyholder's `Permits.shot` checks them as data (PNG by its first bytes, IHDR at most `LIMITS.photoPixels`, 12 a run in memory), sends one at a time `SEND_GAP_MS` apart, and tells the model only the fixed `SHOT` sentences (docs/decisions/new-run-screenshots.md).
- A screenshot is an ordinary message with the sealed `file` field and `fileId`, in the owner's direct chat, with a `run` report of kind `note` or a `prompt` of kind `note`, which changes no state; the pane shows a message with a `file` through `FileBubble`, its text as plain text (docs/decisions/new-run-screenshots.md).
