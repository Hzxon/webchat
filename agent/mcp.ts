// The Claude Code plugin's program (R-030), bundled into plugin/server.mjs. With no argument it is
// the MCP server Claude Code starts with each session, speaking JSON-RPC over stdin and stdout,
// one message per line. One window on a laptop serves every folder its owner connected or had
// cloned, wherever it is open (R-036). With
// "guard" it is the PreToolUse hook: it reads the tool call on stdin and prints a denial, or nothing.
import { execFile } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ClaudePlugin, claudeSecrets, guard, type ToolUse } from './claude.ts';
import { messageOf } from './runs.ts';

const none = { type: 'object', properties: {} };

/**
 * The session's own `claude`, by its absolute path: this server's parent, which the desktop app keeps
 * outside the PATH. Else the first on the PATH, from absolute folders only, since the background
 * Claude starts in a worktree whose files the model writes. Empty when there is none (D-097).
 */
async function claudeProgram() {
  const parent =
    process.platform === 'linux'
      ? await fs.readlink(`/proc/${process.ppid}/exe`).catch(() => '')
      : await promisify(execFile)('ps', ['-o', 'comm=', '-p', String(process.ppid)]).then((r) => r.stdout.trim(), () => '');
  if (path.isAbsolute(parent) && path.basename(parent) === 'claude') return parent;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const file = path.join(dir, 'claude');
    if (await fs.access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return '';
}
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
  const plugin = new ClaudePlugin({
    code: process.env.WEBCHAT_PAIRING_CODE ?? '',
    dataDir,
    projectDir: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    cloneRoot: path.join(os.homedir(), 'WebChat'),
    claude: await claudeProgram(),
    // The folder goes as an argument, since the background Claude's hooks get no plugin variables.
    guard: `"${process.execPath}" "${fileURLToPath(import.meta.url)}" guard "${dataDir}"`,
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
          return { content: [{ type: 'text', text: await plugin.call(String(params.name)) }] };
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

if (process.argv[2] === 'guard') {
  const reason = guard(JSON.parse(readFileSync(0, 'utf8')) as ToolUse, claudeSecrets(process.argv[3] ?? process.env.CLAUDE_PLUGIN_DATA ?? ''));
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} else {
  await serve();
}
