// The Claude Code plugin's program (R-030), bundled into plugin/server.mjs. With no argument it is
// the MCP server Claude Code starts with each session, speaking JSON-RPC over stdin and stdout,
// one message per line. One window on a laptop serves every folder its owner connected or had
// cloned, wherever it is open (R-036). With
// "guard" it is the PreToolUse hook: it reads the tool call on stdin and prints a denial, or nothing.
// With "answer" it is the MCP server that gives an ACP agent its `submit_answer` tool (answer.ts).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAnswerServer } from './answer.ts';
import { claudeSession, runGuard } from './claude.ts';
import { harnessFinder } from './harnesses.ts';
import { Plugin } from './plugin.ts';
import { mcpInit, Peer } from './rpc.ts';
import { messageOf } from './runs.ts';

const none = { type: 'object', properties: {} };

const TOOLS = [
  {
    name: 'status',
    description: 'Says whether this window serves the WebChat agent, which folders it works in, and what stops it if not.',
    inputSchema: none,
  },
  {
    name: 'connect',
    description: 'Lets the WebChat agent work in the repository this session is open in, a copy the owner already has, instead of cloning its own. Only when the user asks for it.',
    inputSchema: none,
    // Claude Code asks the owner on every call, whatever their permission settings, so no repository's files can connect it (D-101).
    _meta: { 'anthropic/requiresUserInteraction': true },
  },
  {
    name: 'disconnect',
    description: 'Stops the WebChat agent working in the repository this session is open in. Its files stay.',
    inputSchema: none,
  },
  {
    name: 'sleep',
    description: 'Puts the WebChat agent to sleep on this laptop, in every window, after the cards and questions it runs. Only when the user asks for it.',
    inputSchema: none,
  },
  {
    name: 'wake',
    description: 'Wakes the WebChat agent that the user put to sleep, so it takes cards and answers questions again. Only when the user asks for it.',
    inputSchema: none,
  },
];

async function serve() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? '';
  // The folder goes as an argument, since the background Claude's hooks get no plugin variables.
  const hook = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" guard "${dataDir}"`;
  const find = harnessFinder({ hook, dataDir }, await claudeSession());
  const plugin = new Plugin({
    code: process.env.WEBCHAT_PAIRING_CODE ?? '',
    dataDir,
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    cloneRoot: path.join(os.homedir(), 'WebChat'),
    harnesses: await find(),
    find,
    // This window has Claude Code, so it asks to link that one; the owner links Codex in Settings.
    picks: ['Claude Code'],
    job: !!process.env.CLAUDE_JOB_DIR,
  });
  // Exiting runs the exit handlers, which free the machine's watch.
  const quit = () => process.exit(0);
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  plugin
    .serve()
    .catch((error: unknown) => {
      plugin.problem = `WebChat stopped: ${messageOf(error)}`;
      console.error(plugin.problem);
    });

  async function answer(method: string, params: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } = {}) {
    switch (method) {
      case 'initialize':
        return mcpInit(params);
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        try {
          return { content: [{ type: 'text', text: await plugin.call(String(params.name)) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: messageOf(error) }], isError: true };
        }
      default:
        throw new Error(`Unknown method ${method}.`);
    }
  }
  // Claude Code closes stdin when the session ends.
  new Peer({ input: process.stdin, output: process.stdout, handle: answer, closed: quit });
}

if (process.argv[2] === 'guard') runGuard(process.argv[3] ?? process.env.CLAUDE_PLUGIN_DATA ?? '');
else if (process.argv[2] === 'answer') runAnswerServer();
else await serve();
