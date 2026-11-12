// How Claude Code asks before an action (docs/decisions/harness-approvals.md): its permission prompt
// tool, `mcp__webchat__approve`, is served here, on a loopback port of this process, by a minimal
// MCP server over HTTP. Each Claude process gets its own token in a config file only the owner reads,
// in the plugin's folder, which neither the shell nor the file tools may read. The tool is hidden from
// the model, and the token never goes in arguments or the environment, which `ps` shows (D-097).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Reply } from './harness.ts';
import { mcpInit } from './rpc.ts';

/** What Claude Code hands its permission prompt tool. */
export interface Call {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

/** The tool's name for Claude Code: the server `webchat`, and the tool `approve`. */
export const APPROVE_TOOL = 'mcp__webchat__approve';

/** Longer than the 7 days a question waits, so Claude Code does not give up first. */
export const TOOL_TIMEOUT_MS = 8 * 24 * 60 * 60_000;
/** A held call sends a comment this often, so no idle limit on the connection ends it. */
const KEEPALIVE_MS = 20_000;
const BODY_LIMIT = 256 * 1024;

const TOOL = {
  name: 'approve',
  description: 'Asks the owner before a tool call.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

const deciders = new Map<string, (call: Call) => Promise<Reply>>();
let listening: Promise<number> | undefined;

/** The one server for every Claude process of this program, started at the first. */
function listen() {
  return (listening ??= new Promise<number>((resolve) => {
    const server = http.createServer((req, res) => void handle(req, res).catch(() => res.headersSent || res.writeHead(500).end()));
    server.requestTimeout = 0;
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve((server.address() as { port: number }).port);
    });
  }));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const decide = token ? deciders.get(hashOf(token)) : undefined;
  // A browser page cannot reach it either: it names an Origin, which Claude Code does not.
  if (!decide || req.headers.origin || req.url !== '/mcp') return void res.writeHead(401).end();
  if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > BODY_LIMIT) return void res.writeHead(413).end();
  }
  const { id, method, params } = JSON.parse(body) as { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Call } };
  const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  if (id === undefined) return void res.writeHead(202).end();
  if (method === 'initialize') return reply(mcpInit(params));
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: [TOOL] });
  if (method !== 'tools/call' || params?.name !== TOOL.name) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method.' } }));
  // The answer may take days, so the response is a stream that starts at once and stays alive.
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const beat = setInterval(() => res.write(': waiting\n\n'), KEEPALIVE_MS);
  res.on('close', () => clearInterval(beat));
  const call = params.arguments as Call;
  const answer = await decide(call).catch((error: unknown): Reply => ({ allow: false, message: error instanceof Error ? error.message : String(error) }));
  // One text block and no structuredContent, as Claude Code requires.
  const text = JSON.stringify(answer.allow ? { behavior: 'allow', updatedInput: call.input } : { behavior: 'deny', message: answer.message });
  res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })}\n\n`);
}

/**
 * Serves the tool to one Claude process, and returns the `--mcp-config` file that names it. `decide`
 * answers each call; `close` ends the token and removes the file.
 */
export async function openApprover(dir: string, decide: (call: Call) => Promise<Reply>) {
  const port = await listen();
  const token = randomBytes(32).toString('hex');
  const file = path.join(dir, `${hashOf(token).slice(0, 16)}.json`);
  const server = { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, timeout: TOOL_TIMEOUT_MS };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ mcpServers: { webchat: server } }), { mode: 0o600 });
  deciders.set(hashOf(token), decide);
  return {
    file,
    close: async () => {
      deciders.delete(hashOf(token));
      await fs.rm(file, { force: true });
    },
  };
}
