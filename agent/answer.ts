// How an ACP agent hands WebChat a turn's answer (docs/decisions/acp-adapter.md). The agent starts
// `<this program> answer` as an MCP server with one tool, `submit_answer`, whose input is the turn's
// JSON schema. That server runs apart from the adapter, so it passes each call to the adapter over a
// local socket, where `fits` checks it against the schema: nothing else does for an ACP agent.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { mcpInit, Peer } from './rpc.ts';

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

/**
 * Why `value` does not fit `schema`, or undefined when it does. It knows the keywords the plugin's
 * schemas use, and ignores the others.
 */
export function fits(schema: Schema, value: unknown, at = 'the answer'): string | undefined {
  if (schema.enum && !schema.enum.includes(value)) return `${at}: expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  const is = (type: string) => typeof value === type;
  switch (schema.type) {
    case 'object': {
      if (!value || !is('object') || Array.isArray(value)) return `${at}: expected an object`;
      const object = value as Record<string, unknown>;
      for (const name of schema.required ?? []) if (object[name] === undefined) return `${at}.${name}: required`;
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        const problem = object[name] === undefined ? undefined : fits(property, object[name], `${at}.${name}`);
        if (problem) return problem;
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at}: expected an array`;
      for (const [i, item] of value.entries()) {
        const problem = schema.items && fits(schema.items, item, `${at}[${i}]`);
        if (problem) return problem;
      }
      return;
    }
    case 'string':
    case 'boolean':
      return is(schema.type) ? undefined : `${at}: expected a ${schema.type}`;
    case 'number':
    case 'integer':
      return Number.isFinite(value) && (schema.type === 'number' || Number.isInteger(value)) ? undefined : `${at}: expected a${schema.type === 'integer' ? 'n integer' : ' number'}`;
  }
}

/** A model fills a nullable optional with null, as Codex's does; the plugin's schemas leave it out. */
const withoutNulls = (value: unknown) => JSON.parse(JSON.stringify(value), (_key, v: unknown) => (v === null ? undefined : v)) as unknown;

/** The calls with an answer that does not fit that a turn takes before it fails. */
const MISFITS = 3;

/**
 * The adapter's end, for one agent process, which takes many turns: a socket in a folder only the
 * owner reads, and a token, which keeps two processes' servers apart. Neither is a boundary against
 * the model, which writes the answer whichever way it comes.
 */
export async function listenForAnswers() {
  const id = randomBytes(8).toString('hex');
  const token = randomBytes(16).toString('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-answer-'));
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\webchat-answer-${id}` : path.join(dir, 's');
  const connections = new Set<net.Socket>();
  /** The turn waiting for its answer, and the schema the servers last served. */
  let turn: { schema: Schema; resolve: (answer: unknown) => void; reject: (error: Error) => void; misfits: number } | undefined;
  let schema: Schema = {};
  let served: string | undefined;

  const server = net.createServer((socket) => {
    connections.add(socket.on('close', () => connections.delete(socket)).on('error', () => undefined));
    readline.createInterface({ input: socket }).on('line', (line) => {
      const call = JSON.parse(line) as { token?: string; id: number; op?: string; arguments?: unknown };
      const reply = (message: object) => socket.write(`${JSON.stringify({ id: call.id, ...message })}\n`);
      if (call.token !== token) return reply({ error: 'No.' });
      if (call.op === 'schema') {
        served = JSON.stringify(schema);
        return reply({ schema });
      }
      if (!turn) return reply({ error: 'No question is waiting for an answer.' });
      const value = withoutNulls(call.arguments);
      const problem = fits(turn.schema, value);
      if (!problem) {
        turn.resolve(value);
        turn = undefined;
        return reply({ ok: true });
      }
      if (++turn.misfits >= MISFITS) turn.reject(new Error(`the agent's answers did not fit: ${problem}.`));
      reply({ error: `${problem}. Call submit_answer again with an answer that fits.` });
    })
      // readline passes a failed read on, and on Linux an answer server that exits with a reply unread resets the socket.
      .on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(address, resolve));

  return {
    env: [
      { name: 'WEBCHAT_ANSWER_SOCKET', value: address },
      { name: 'WEBCHAT_ANSWER_TOKEN', value: token },
    ],
    /** Waits for the answer to one turn. A turn may differ in schema from the last, so the servers are told to list their tool again. */
    ask(next: object) {
      schema = next;
      if (served !== undefined && served !== JSON.stringify(next)) for (const socket of connections) socket.write(`${JSON.stringify({ changed: true })}\n`);
      return new Promise<unknown>((resolve, reject) => (turn = { schema: next, resolve, reject, misfits: 0 }));
    },
    /** Stops waiting, when the turn ended without an answer. */
    rest() {
      turn = undefined;
    },
    close() {
      for (const socket of connections) socket.destroy();
      server.close();
      return fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const DESCRIPTION = 'Ends your turn with your answer. Call it once, with the answer as the arguments, and write no answer as text.';

/** The MCP server an agent starts as `<this program> answer`, which passes its one tool to the adapter. */
export function runAnswerServer() {
  const socket = net.connect(process.env.WEBCHAT_ANSWER_SOCKET ?? '');
  const token = process.env.WEBCHAT_ANSWER_TOKEN;
  let next = 1;
  const waiting = new Map<number, (message: { schema?: object; ok?: true; error?: string }) => void>();
  const quit = () => process.exit(0);
  socket.on('error', quit).on('close', quit);
  readline.createInterface({ input: socket }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; changed?: true; schema?: object; ok?: true; error?: string };
    if (message.changed) peer.notify('notifications/tools/list_changed');
    else if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const call = (op: string, args?: unknown) =>
    new Promise<{ schema?: object; ok?: true; error?: string }>((resolve) => {
      waiting.set(next, resolve);
      socket.write(`${JSON.stringify({ token, id: next++, op, arguments: args })}\n`);
    });
  const peer = new Peer({
    input: process.stdin,
    output: process.stdout,
    closed: quit,
    async handle(method, params: { protocolVersion?: string; name?: string; arguments?: unknown } = {}) {
      switch (method) {
        case 'initialize':
          return mcpInit(params, true);
        case 'ping':
          return {};
        case 'tools/list':
          return { tools: [{ name: 'submit_answer', description: DESCRIPTION, inputSchema: (await call('schema')).schema }] };
        case 'tools/call': {
          if (params.name !== 'submit_answer') throw new Error(`Unknown tool ${params.name}.`);
          const { error } = await call('answer', params.arguments);
          return { content: [{ type: 'text', text: error ?? 'Received. Write nothing more.' }], ...(error && { isError: true }) };
        }
        default:
          throw new Error(`Unknown method ${method}.`);
      }
    },
  });
}
