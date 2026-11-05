// The Claude Code plugin's program (R-030), bundled into plugin/server.mjs. With no argument it is
// the MCP server Claude Code starts with each session, speaking JSON-RPC over stdin and stdout,
// one message per line. With "guard" it is the PreToolUse hook: it reads the tool call on stdin
// and prints a denial, or nothing. With "doorbell" it prints the doorbell of the repository the
// session is open in, for the monitor to tail (D-094).
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { guard, originOf, Plugin, readRunStates, repoHome, secretDirs, type ToolUse } from './plugin.ts';
import { messageOf } from './runs.ts';

const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '';

const id = { id: { type: 'string', description: 'The id the WebChat line named.' } };
const TOOLS = [
  {
    name: 'status',
    description: 'Says whether this session is paired with WebChat and takes runs, and what stops it if not.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_run',
    description: 'Starts a run or fix that a WebChat line named. Returns the card or what to fix, and the worktree to work in.',
    inputSchema: { type: 'object', properties: id, required: ['id'] },
  },
  {
    name: 'publish',
    description: "Pushes the run's branch to GitHub and, the first time, opens a draft pull request with this title and body.",
    inputSchema: {
      type: 'object',
      properties: { ...id, title: { type: 'string' }, body: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'finish',
    description: 'Reports the run or fix in WebChat: done after publish, or failed with what blocks it.',
    inputSchema: {
      type: 'object',
      properties: { ...id, outcome: { type: 'string', enum: ['done', 'failed'] }, note: { type: 'string', description: 'One or two sentences.' } },
      required: ['id', 'outcome', 'note'],
    },
  },
];

function serve() {
  const plugin = new Plugin({
    server: process.env.WEBCHAT_SERVER ?? '',
    code: process.env.WEBCHAT_PAIRING_CODE ?? '',
    dataDir,
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  });
  // Exiting runs the exit handlers, which free the machine's watch.
  const quit = () => process.exit(0);
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  plugin
    .start()
    .then((watching) => (watching ? plugin.loop() : undefined))
    .catch((error: unknown) => {
      plugin.problem = `WebChat stopped: ${messageOf(error)}`;
      console.error(plugin.problem);
    });

  const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  async function answer(method: string, params: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } = {}) {
    switch (method) {
      case 'initialize':
        return { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'webchat', version: '1' } };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        try {
          return { content: [{ type: 'text', text: await plugin.call(String(params.name), params.arguments ?? {}) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: messageOf(error) }], isError: true };
        }
      default:
        throw new Error(`Unknown method ${method}.`);
    }
  }
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let request: { id?: number | string; method: string; params?: Parameters<typeof answer>[1] };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      return;
    }
    // A notification, such as notifications/initialized, needs no answer.
    if (request.id === undefined) return;
    answer(request.method, request.params).then(
      (result) => send({ id: request.id, result }),
      (error: unknown) => send({ id: request.id, error: { code: -32601, message: messageOf(error) } }),
    );
  });
  // Claude Code closes stdin when the session ends.
  lines.on('close', quit);
}

if (process.argv[2] === 'doorbell') {
  // A monitor gets no plugin variables, so the folder comes as an argument. Outside a GitHub
  // repository nothing rings.
  const repo = await originOf(process.cwd());
  const file = repo ? path.join(repoHome(process.argv[3]!, repo), 'doorbell') : '/dev/null';
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  process.stdout.write(file);
} else if (process.argv[2] === 'guard') {
  const reason = guard(JSON.parse(readFileSync(0, 'utf8')) as ToolUse, secretDirs(dataDir), readRunStates(dataDir));
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} else {
  serve();
}
