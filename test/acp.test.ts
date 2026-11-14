import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, before, beforeEach, describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { acpHarness } from '../agent/acp.ts';
import { ACP_AGENTS, type AcpAgent } from '../agent/acp-agents.ts';
import { fits, listenForAnswers } from '../agent/answer.ts';
import { Peer } from '../agent/rpc.ts';
import { acpRow, harnessFinder, SUPPORTED, supported, supportedList } from '../agent/harnesses.ts';
import type { Ask, Harness, Reply, Turn } from '../agent/harness.ts';
import { HARNESS_WARNING, LIMITS } from '../shared/types.ts';

/**
 * Stands in for an ACP agent. It is also the MCP client that a real agent is: at a session's start
 * it runs the MCP server it was given, and a prompt ends with calls of `submit_answer`. It logs
 * what it gets to FAKE_ACP_LOG, and what it does follows FAKE_ACP_* variables.
 */
const FAKE_ACP = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
if (process.argv[2] === '--version') {
  console.log('fake-acp 0.3.1');
  process.exit(0);
}
const env = process.env;
const log = (entry) => fs.appendFileSync(env.FAKE_ACP_LOG, JSON.stringify(entry) + '\n');
const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
log({ start: { argv: process.argv.slice(2), env, pid: process.pid } });
if (env.FAKE_ACP_PIDFILE) fs.writeFileSync(env.FAKE_ACP_PIDFILE, String(process.pid));
const OPTIONS = [
  { optionId: 'aa', name: 'Always', kind: 'allow_always' },
  { optionId: 'ao', name: 'Once', kind: 'allow_once' },
  { optionId: 'ra', name: 'Never', kind: 'reject_always' },
  { optionId: 'ro', name: 'No', kind: 'reject_once' },
];
let next = 1;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => (waiting.set(next, resolve), out({ id: next++, method, params })));
let server;
let mcpNext = 1;
const mcpWaiting = new Map();
const mcp = (method, params) => new Promise((resolve) => (mcpWaiting.set(mcpNext, resolve), server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mcpNext++, method, params }) + '\n')));
process.on('exit', () => server?.kill());
async function startMcp(config) {
  server?.kill();
  log({ mcp: config });
  server = spawn(config.command, config.args, { env: { ...process.env, ...Object.fromEntries(config.env.map((e) => [e.name, e.value])) } });
  readline.createInterface({ input: server.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined) mcpWaiting.get(m.id)?.(m);
    else log({ mcpNote: m.method });
  });
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
}
let prompts = 0;
let current;
let authed = false;
async function prompt(params) {
  const n = prompts++;
  log({ prompt: params.prompt[0].text, n });
  if (env.FAKE_ACP_NOTE) out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'Reading secrets', locations: [{ path: 'sum.js' }] } } });
  if (env.FAKE_ACP_TEXT) out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: env.FAKE_ACP_TEXT } } } });
  for (const item of JSON.parse(env.FAKE_ACP_ASK ?? '[]')) {
    const reply = await ask('session/request_permission', { sessionId: 'acp-1', toolCall: item.toolCall, options: item.options ?? OPTIONS });
    log({ permission: item.toolCall.title, answer: reply.result });
  }
  if (env.FAKE_ACP_FS) for (const method of ['fs/read_text_file', 'terminal/create']) log({ refused: method, code: (await ask(method, { sessionId: 'acp-1' })).error?.code });
  if (env.FAKE_ACP_HANG) return new Promise(() => {});
  const calls = JSON.parse(env.FAKE_ACP_ANSWERS ?? '[[{"reply":"It adds."}]]')[n] ?? [];
  if (calls.length) log({ tools: (await mcp('tools/list', {})).result.tools });
  for (const args of calls) {
    const reply = (await mcp('tools/call', { name: 'submit_answer', arguments: args })).result;
    log({ call: args, isError: reply.isError ?? false, text: reply.content[0].text });
  }
  if (env.FAKE_ACP_SLOW_END) return new Promise(() => {});
  return 'end_turn';
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) return waiting.get(m.id)?.(m);
  log({ in: m.method, params: m.params });
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      if (env.FAKE_ACP_CRASH) (console.error('boom: no key'), process.exit(3));
      if (env.FAKE_ACP_HANG_INIT) return;
      return reply({
        protocolVersion: Number(env.FAKE_ACP_PROTOCOL ?? 1),
        agentCapabilities: { loadSession: !!env.FAKE_ACP_LOAD, sessionCapabilities: env.FAKE_ACP_RESUME ? { resume: {} } : {} },
        authMethods: env.FAKE_ACP_SIGNIN ? [{ id: 'key', name: 'Key', ...(env.FAKE_ACP_SIGNIN === 'terminal' && { type: 'terminal' }) }] : [],
      });
    case 'authenticate':
      authed = true;
      return reply({});
    case 'session/new':
    case 'session/resume':
    case 'session/load':
      if (env.FAKE_ACP_SIGNIN && !authed) return out({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
      await startMcp(m.params.mcpServers[0]);
      if (m.method === 'session/load') out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', kind: 'read', title: 'Replayed', locations: [{ path: process.cwd() + '/old.js' }] } } });
      return reply(m.method === 'session/new' ? { sessionId: 'acp-1' } : {});
    case 'session/prompt': {
      current = m.id;
      const stop = await prompt(m.params);
      current = undefined;
      return reply({ stopReason: stop });
    }
    case 'session/cancel':
      if (env.FAKE_ACP_CANCEL_ENDS && current !== undefined) out({ id: current, result: { stopReason: 'cancelled' } });
  }
}).on('close', () => process.exit(0));
`;

const REPLY = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
const CHECK = { type: 'object', properties: { outcome: { type: 'string', enum: ['holds', 'stale'] } }, required: ['outcome'] };
const tsx = fileURLToPath(import.meta.resolve('tsx'));
/** What an agent starts as `<self> answer`: the plugin's own program, as the daemon would run it. */
const SELF = [process.execPath, '--import', tsx, fileURLToPath(new URL('../agent/index.ts', import.meta.url))];

const FAKE: AcpAgent = {
  id: 'fake',
  name: 'Fake',
  program: 'fake-acp',
  args: ['--acp'],
  isolation: { args: ['--no-user-config'], env: { FAKE_ISOLATED: '1' }, checked: '2026-11-13: fake-acp --help lists --no-user-config' },
  min: '0.2.0',
  login: ['FAKE_LOGIN_TOKEN'],
  checked: '2026-11-13: fake-acp --version printed fake-acp 0.3.1',
};

/** Why a list entry may not ship, or undefined (docs/decisions/acp-adapter.md). */
function entryProblem(agent: AcpAgent, others: AcpAgent[] = []) {
  if (!/^[a-z0-9-]+$/.test(agent.id)) return 'its id is not lower case letters, digits and dashes';
  if (['claude', 'codex'].includes(agent.id) || ['claude code', 'codex'].includes(agent.name.toLowerCase())) return 'it takes a built-in adapter\'s name';
  if (others.some((o) => o.id === agent.id || o.name === agent.name)) return 'its id or name is taken';
  // A path or a launcher would run something the owner never installed.
  if (!/^[a-z][a-z0-9._-]*$/.test(agent.program) || ['npx', 'uvx', 'bunx', 'pipx', 'sh', 'bash', 'zsh', 'env', 'node', 'python', 'python3'].includes(agent.program)) return 'its program is a path or a launcher';
  if (!/^\d+(\.\d+)*$/.test(agent.min)) return 'its minimum version is no version';
  if (!/^\d{4}-\d\d-\d\d: \S/.test(agent.checked)) return 'it has no dated check';
  const { isolation } = agent;
  // An agent that cannot run isolated ships only with a warning the owner reads before linking it.
  if (!isolation) return HARNESS_WARNING[agent.name] ? undefined : 'it has no isolation and no warning for the owner';
  if (!isolation.args?.length && !Object.keys(isolation.env ?? {}).length) return 'it has no flag or variable that skips the owner\'s settings and MCP servers';
  if (!/^\d{4}-\d\d-\d\d: \S/.test(isolation.checked)) return 'its isolation has no dated check';
}

describe('the ACP adapter', () => {
  let root: string;
  let work: string;
  let data: string;
  let program: string;
  let logFile: string;
  let pidFile: string;
  const saved = { ...process.env };
  const made: Harness[] = [];

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-acp-')));
    program = path.join(root, 'bin', 'fake-acp');
    await fs.mkdir(path.dirname(program));
    await fs.writeFile(program, FAKE_ACP, { mode: 0o755 });
  });

  beforeEach(async () => {
    work = path.join(root, `work-${randomUUID()}`);
    data = path.join(root, `data-${randomUUID()}`);
    await Promise.all([work, data].map((dir) => fs.mkdir(dir)));
    [logFile, pidFile] = [path.join(data, 'log.jsonl'), path.join(data, 'pid')];
    Object.assign(process.env, { FAKE_ACP_LOG: logFile, FAKE_ACP_PIDFILE: pidFile });
  });

  afterEach(async () => {
    await Promise.all(made.splice(0).map((harness) => harness.end?.()));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  const adapter = (timing: Parameters<typeof acpHarness>[0]['timing'] = {}, agent = FAKE) => {
    const harness = acpHarness({ agent, program, self: SELF, dataDir: data, timing });
    made.push(harness);
    return harness;
  };
  const turn = (over: Partial<Turn> = {}): Turn => ({ cwd: work, session: 's1', resume: false, message: 'What does sum.js do?', schema: REPLY, setup: {}, signal: new AbortController().signal, ...over });
  const log = async () =>
    (await fs.readFile(logFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  const logged = async (key: string) => (await log()).filter((entry) => key in entry);
  const alive = async () => {
    try {
      process.kill(Number(await fs.readFile(pidFile, 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async () => {
    for (let i = 0; i < 100 && (await alive()); i++) await sleep(50);
    return !(await alive());
  };

  test('a peer whose input breaks throws nothing: on Linux a child that exits resets its pipe', async () => {
    const input = new PassThrough();
    new Peer({ input, output: new PassThrough() });
    input.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await sleep(10);
  });

  test('fits reads the keywords the plugin\'s schemas use', () => {
    const schema = { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'failed'] }, drafts: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }, ok: { type: 'boolean' } }, required: ['outcome'] };
    assert.equal(fits(schema, { outcome: 'done', drafts: [{ n: 1 }], ok: true }), undefined);
    assert.equal(fits(schema, { outcome: 'done', extra: 1 }), undefined);
    assert.equal(fits(schema, {}), 'the answer.outcome: required');
    assert.equal(fits(schema, { outcome: 'later' }), 'the answer.outcome: expected one of "done", "failed"');
    assert.equal(fits(schema, { outcome: 'done', drafts: [{ n: 1.5 }] }), 'the answer.drafts[0].n: expected an integer');
    assert.equal(fits(schema, { outcome: 'done', drafts: {} }), 'the answer.drafts: expected an array');
    assert.equal(fits(schema, { outcome: 'done', ok: 'yes' }), 'the answer.ok: expected a boolean');
    assert.equal(fits(schema, [1]), 'the answer: expected an object');
  });

  test('the answer socket stays short enough for macOS, and serves nobody without the token', async () => {
    const listener = await listenForAnswers();
    try {
      const address = listener.env[0].value;
      if (process.platform !== 'win32') assert.ok(address.length < 104, address);
      const socket = net.connect(address);
      const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
      socket.write(`${JSON.stringify({ token: 'wrong', id: 1, op: 'schema' })}\n`);
      assert.deepEqual(JSON.parse((await lines.next()).value as string), { id: 1, error: 'No.' });
      // An agent lists the tool before the first turn; Hermes drops a server whose schema is not an object.
      socket.write(`${JSON.stringify({ token: listener.env[1].value, id: 2, op: 'schema' })}\n`);
      assert.deepEqual(JSON.parse((await lines.next()).value as string), { id: 2, schema: { type: 'object' } });
      socket.destroy();
    } finally {
      await listener.close();
    }
  });

  test('a turn answers through submit_answer, with the message on the protocol and in no argument or variable', async () => {
    process.env.FAKE_ACP_NOTE = '1';
    process.env.GH_TOKEN = 'canary-gh';
    const progress: string[] = [];
    const answer = await adapter().turn(turn({ progress: (sentence) => progress.push(sentence) }));
    assert.deepEqual(answer, { reply: 'It adds.' });
    const entries = await log();
    const one = (match: (e: Record<string, any>) => unknown) => entries.find(match)!;
    const start = one((e) => e.start).start;
    assert.deepEqual(start.argv, ['--acp', '--no-user-config']);
    assert.equal(start.env.FAKE_ISOLATED, '1');
    const init = one((e) => e.in === 'initialize').params;
    assert.deepEqual([init.protocolVersion, init.clientCapabilities], [1, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }]);
    const create = one((e) => e.in === 'session/new').params;
    assert.equal(create.cwd, work);
    assert.equal(create.mcpServers.length, 1);
    const [mcp] = create.mcpServers;
    assert.deepEqual([mcp.name, mcp.command, mcp.args.at(-1)], ['webchat', process.execPath, 'answer']);
    assert.ok(Array.isArray(mcp.env));
    assert.deepEqual(one((e) => e.tools).tools[0].inputSchema, REPLY);
    const prompt = one((e) => 'prompt' in e).prompt as string;
    assert.ok(prompt.includes('What does sum.js do?') && prompt.includes('submit_answer'));
    // D-097: the message reaches the agent's stdin only, and no secret reaches it at all.
    const everywhere = JSON.stringify([start.argv, start.env, mcp.args, mcp.env]);
    assert.ok(!everywhere.includes('What does sum.js do?') && !everywhere.includes('canary-gh'));
    // A sentence of ours, built from the kind and the file, never the agent's own title.
    assert.deepEqual(progress, ['Reading sum.js']);
  });

  test('a session keeps one process for its turns, and serves each turn\'s own schema', async () => {
    process.env.FAKE_ACP_ANSWERS = JSON.stringify([[{ reply: 'First.' }], [{ outcome: 'holds' }]]);
    const harness = adapter();
    assert.deepEqual(await harness.turn(turn()), { reply: 'First.' });
    assert.deepEqual(await harness.turn(turn({ resume: true, schema: CHECK, message: 'Check the card.' })), { outcome: 'holds' });
    const entries = await log();
    assert.equal(entries.filter((e) => e.start).length, 1);
    assert.equal(entries.filter((e) => e.in === 'initialize').length, 1);
    assert.equal(entries.filter((e) => 'prompt' in e).length, 2);
    assert.ok(entries.some((e) => e.mcpNote === 'notifications/tools/list_changed'));
    assert.deepEqual(entries.filter((e) => e.tools).map((e) => e.tools[0].inputSchema), [REPLY, CHECK]);
    assert.ok(await alive());
    await harness.end!('s1');
    assert.ok(await gone());
  });

  test('a turn checks the answer against its own schema: a miss is sent back, three fail the turn', async () => {
    process.env.FAKE_ACP_ANSWERS = JSON.stringify([[{ reply: 7 }, { reply: 'Fixed.', stray: null }]]);
    assert.deepEqual(await adapter().turn(turn()), { reply: 'Fixed.' });
    const calls = await logged('call');
    assert.deepEqual(calls.map((c) => c.isError), [true, false]);
    assert.match(calls[0].text, /the answer\.reply: expected a string/);
    process.env.FAKE_ACP_ANSWERS = JSON.stringify([[{}, {}, {}]]);
    await assert.rejects(adapter().turn(turn({ session: 's2' })), /the agent's answers did not fit: the answer\.reply: required/);
  });

  test('a turn that ends without the call is told twice, then fails with what the agent said', async () => {
    process.env.FAKE_ACP_ANSWERS = JSON.stringify([[], [], [{ reply: 'Late.' }]]);
    assert.deepEqual(await adapter().turn(turn()), { reply: 'Late.' });
    assert.equal((await logged('prompt')).length, 3);
    process.env.FAKE_ACP_ANSWERS = '[]';
    process.env.FAKE_ACP_TEXT = 'I think it adds.';
    await assert.rejects(adapter().turn(turn({ session: 's2' })), /^Error: I think it adds\./);
  });

  test('permission requests get the rulebook\'s answer, once, and never a standing rule', async () => {
    await fs.symlink(data, path.join(work, 'link'));
    const call = (title: string, kind: string, ...paths: string[]) => ({ toolCall: { toolCallId: title, title, kind, locations: paths.map((p) => ({ path: p })) } });
    process.env.FAKE_ACP_ASK = JSON.stringify([
      call('inside', 'read', path.join(work, 'sum.js')),
      call('relative', 'edit', 'sum.js'),
      call('outside', 'read', path.join(root, 'other.js')),
      call('secret', 'read', path.join(data, 'account.json')),
      call('through a link', 'read', path.join(work, 'link', 'account.json')),
      call('shell', 'execute'),
      call('webchat', 'other', 'submit_answer'),
      { toolCall: { toolCallId: 'x', title: 'mcp__webchat__submit_answer', kind: 'other' } },
      { toolCall: { toolCallId: 'y', title: 'mcp__owner__mail', kind: 'other' } },
      { ...call('inside', 'read', path.join(work, 'a.js')), options: [{ optionId: 'aa', name: 'Always', kind: 'allow_always' }, { optionId: 'ra', name: 'Never', kind: 'reject_always' }] },
    ]);
    // A tool with a title of its own is asked about, whatever the title says: only a `submit_answer` name is let through.
    await adapter().turn(turn());
    const answers = (await logged('permission')).map((e) => [e.permission, e.answer.outcome.optionId ?? e.answer.outcome.outcome]);
    assert.deepEqual(answers, [
      ['inside', 'ao'],
      ['relative', 'ao'],
      ['outside', 'ro'],
      ['secret', 'ro'],
      ['through a link', 'ro'],
      ['shell', 'ro'],
      ['webchat', 'ro'],
      ['mcp__webchat__submit_answer', 'ao'],
      ['mcp__owner__mail', 'ro'],
      ['inside', 'cancelled'],
    ]);
  });

  test('what the rulebook cannot decide goes to the owner when the turn can ask, and only a once is ever chosen (docs/decisions/harness-approvals.md)', async () => {
    const call = (title: string, kind: string, ...paths: string[]) => ({ toolCall: { toolCallId: title, title, kind, rawInput: { command: `run ${title}` }, locations: paths.map((p) => ({ path: p })) } });
    process.env.FAKE_ACP_ASK = JSON.stringify([
      call('shell', 'execute'),
      call('shell no', 'execute'),
      call('inside', 'read', path.join(work, 'sum.js')),
      call('secret', 'read', path.join(data, 'account.json')),
      { toolCall: { toolCallId: 'x', title: 'mcp__owner__mail', kind: 'other' } },
    ]);
    const asked: Ask[] = [];
    const replies: Reply[] = [{ allow: true }, { allow: false, message: 'No.' }, { allow: true }];
    await adapter().turn(turn({ ask: async (ask) => (asked.push(ask), replies[asked.length - 1]!) }));
    // The rulebook allows what is in the folder and refuses what is secret, and asks the owner for the rest.
    assert.deepEqual(asked.map((a) => [a.kind, a.detail]), [['execute', 'run shell'], ['execute', 'run shell no'], ['other', 'mcp__owner__mail']]);
    assert.deepEqual((await logged('permission')).map((e) => [e.permission, e.answer.outcome.optionId]), [['shell', 'ao'], ['shell no', 'ro'], ['inside', 'ao'], ['secret', 'ro'], ['mcp__owner__mail', 'ao']]);
    // A question that cannot be asked, as when nobody answered in 7 days, fails the turn with its reason.
    process.env.FAKE_ACP_ASK = JSON.stringify([call('shell', 'execute')]);
    await assert.rejects(adapter().turn(turn({ session: 's2', ask: () => Promise.reject(new Error('No answer came within 7 days.')) })), /^Error: No answer came within 7 days\.$/);
  });

  test('the agent\'s file and terminal methods get a method-not-found error, since none was offered', async () => {
    process.env.FAKE_ACP_FS = '1';
    await adapter().turn(turn());
    assert.deepEqual((await logged('refused')).map((e) => [e.refused, e.code]), [['fs/read_text_file', -32601], ['terminal/create', -32601]]);
  });

  test('a session resumes in a new process, by resume when the agent has it, else by load', async () => {
    process.env.FAKE_ACP_RESUME = '1';
    await adapter({ keep: 50 }).turn(turn());
    // A new adapter, as after a restart, still finds the agent's id of the session.
    await adapter().turn(turn({ resume: true }));
    assert.deepEqual((await logged('in')).map((e) => e.in).filter((m) => m.startsWith('session/') && m !== 'session/prompt'), ['session/new', 'session/resume']);
    assert.equal((await logged('in')).find((e) => e.in === 'session/resume')!.params.sessionId, 'acp-1');

    delete process.env.FAKE_ACP_RESUME;
    process.env.FAKE_ACP_LOAD = '1';
    const progress: string[] = [];
    await adapter().turn(turn({ resume: true, progress: (sentence) => progress.push(sentence) }));
    assert.ok((await logged('in')).some((e) => e.in === 'session/load'));
    assert.deepEqual(progress, [], 'what a load replays is no progress');

    delete process.env.FAKE_ACP_LOAD;
    await assert.rejects(adapter().turn(turn({ resume: true })), /Fake cannot resume a session\./);
    await assert.rejects(adapter().turn(turn({ resume: true, session: 'unknown' })), /I no longer have that session\./);
  });

  test('the owner\'s cancel sends the agent a cancel, ends its process and fails the turn', async () => {
    process.env.FAKE_ACP_HANG = '1';
    const stop = new AbortController();
    const running = adapter().turn(turn({ signal: stop.signal }));
    while (!(await logged('prompt')).length) await sleep(20);
    stop.abort();
    await assert.rejects(running, /the owner cancelled the run\./);
    assert.ok(await gone());
    assert.equal((await logged('in')).filter((e) => e.in === 'session/cancel').length, 1);
    await assert.rejects(adapter().turn(turn({ signal: stop.signal })), /the owner cancelled the run\./);
  });

  test('an agent that goes quiet is killed, and one that does not start is told so', async () => {
    process.env.FAKE_ACP_HANG = '1';
    await assert.rejects(adapter({ idle: 300 }).turn(turn()), /the agent printed nothing for 0 minutes\./);
    assert.ok(await gone());
    delete process.env.FAKE_ACP_HANG;
    process.env.FAKE_ACP_HANG_INIT = '1';
    await assert.rejects(adapter({ start: 300 }).turn(turn()), /Fake did not start in ACP mode\. Check that "fake-acp --acp" runs on its own\./);
    assert.ok(await gone());
  });

  test('an agent that ends before it answers its prompt after the answer is cancelled, then ended', async () => {
    process.env.FAKE_ACP_SLOW_END = '1';
    process.env.FAKE_ACP_CANCEL_ENDS = '1';
    const harness = adapter({ grace: 200 });
    assert.deepEqual(await harness.turn(turn()), { reply: 'It adds.' });
    assert.equal((await logged('in')).filter((e) => e.in === 'session/cancel').length, 1);
    // It ended its prompt on the cancel, so its process stays for the next turn.
    assert.ok(await alive());
    await harness.end!('s1');
  });

  test('an idle agent is ended after the keep time, and the session starts it again', async () => {
    const harness = adapter({ keep: 150 });
    await harness.turn(turn());
    assert.ok(await gone());
    process.env.FAKE_ACP_RESUME = '1';
    await harness.turn(turn({ resume: true }));
    assert.equal((await logged('start')).length, 2);
    await harness.end!('s1');
  });

  test('failures say why: a crash, another protocol version, a sign-in the owner must make', async () => {
    process.env.FAKE_ACP_CRASH = '1';
    await assert.rejects(adapter().turn(turn()), /Fake exited with code 3: boom: no key/);
    delete process.env.FAKE_ACP_CRASH;
    process.env.FAKE_ACP_PROTOCOL = '2';
    await assert.rejects(adapter().turn(turn()), /Fake speaks ACP version 2, and I speak 1\./);
    delete process.env.FAKE_ACP_PROTOCOL;
    process.env.FAKE_ACP_SIGNIN = 'terminal';
    await assert.rejects(adapter().turn(turn()), /Fake needs you to sign in: run fake-acp on your laptop once\./);
    assert.equal((await logged('in')).filter((e) => e.in === 'authenticate').length, 0);
    process.env.FAKE_ACP_SIGNIN = 'agent';
    assert.deepEqual(await adapter().turn(turn()), { reply: 'It adds.' });
    assert.equal((await logged('in')).filter((e) => e.in === 'authenticate').length, 1);
  });

  test('the agent gets no credential but those its own sign-in keeps', async () => {
    Object.assign(process.env, { GH_TOKEN: 'canary-gh', NPM_TOKEN: 'canary-npm', FAKE_LOGIN_TOKEN: 'canary-login', EDITOR: 'vim' });
    await adapter().turn(turn());
    const { env } = (await logged('start'))[0].start;
    assert.deepEqual([env.GH_TOKEN, env.NPM_TOKEN, env.FAKE_LOGIN_TOKEN, env.EDITOR], [undefined, undefined, 'canary-login', 'vim']);
  });

  test('refusal and found say what this laptop has', async () => {
    assert.equal(await acpHarness({ agent: FAKE, program: '', self: SELF, dataDir: data }).refusal(), 'I cannot find Fake on this laptop.');
    const harness = adapter();
    assert.equal(await harness.refusal(), undefined);
    assert.deepEqual(await harness.found(), { path: program, version: '0.3.1' });
    assert.deepEqual(harness.offers(), { knobs: [] });
    assert.equal(await harness.warning?.(), undefined);
    const hermes = ACP_AGENTS.find((a) => a.id === 'hermes')!;
    assert.equal(await acpHarness({ agent: hermes, program: '', self: SELF, dataDir: data }).warning?.(), HARNESS_WARNING.Hermes, 'Settings shows the owner what an unconfined agent can reach');
    assert.equal(await acpHarness({ agent: { ...FAKE, min: '0.4.0' }, program, self: SELF, dataDir: data }).refusal(), 'Fake 0.3.1 is older than 0.4.0, which I need. Update it.');
  });

  test('the shipped list holds only entries that isolate the agent from the owner\'s setup, or warn the owner', () => {
    ACP_AGENTS.forEach((agent, i) => assert.equal(entryProblem(agent, ACP_AGENTS.slice(0, i) as AcpAgent[]), undefined, agent.id));
    // `readHarnesses` drops what passes LIMITS.harnesses, the two built-in adapters among them.
    assert.ok(2 + ACP_AGENTS.length <= LIMITS.harnesses);
    assert.equal(entryProblem(FAKE), undefined);
    const bad: [Partial<AcpAgent>, RegExp][] = [
      [{ isolation: { args: [], env: {}, checked: '2026-11-13: x' } }, /no flag or variable/],
      [{ isolation: undefined }, /no isolation and no warning/],
      [{ isolation: { args: ['--bare'], env: {}, checked: 'checked' } }, /isolation has no dated check/],
      [{ program: '/usr/bin/fake' }, /path or a launcher/],
      [{ program: 'npx' }, /path or a launcher/],
      [{ id: 'Fake_1' }, /id is not/],
      [{ id: 'codex' }, /built-in/],
      [{ name: 'Claude Code' }, /built-in/],
      [{ min: 'latest' }, /minimum version/],
      [{ checked: '' }, /dated check/],
    ];
    for (const [change, why] of bad) assert.match(entryProblem({ ...FAKE, ...change })!, why);
    assert.match(entryProblem(FAKE, [FAKE])!, /taken/);
  });

  test('an agent that is not on the list cannot be linked, found or run', async () => {
    assert.equal(supported('gemini'), undefined);
    assert.equal(supportedList(), 'claude (Claude Code), codex (Codex), hermes (Hermes)');
    // A program of that name on the PATH is never started, not even to read its version.
    const marker = path.join(root, `gemini-ran-${randomUUID()}`);
    await fs.writeFile(path.join(root, 'bin', 'gemini'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${saved.PATH}`;
    const found = await harnessFinder({ dataDir: data })();
    await Promise.all(found.map((harness) => harness.found()));
    assert.deepEqual(found.map((harness) => harness.name), SUPPORTED.map((s) => s.name));
    assert.equal(await fs.access(marker).then(() => true, () => false), false);
  });

  test('an agent on the list is found by its file name, linked by its id, and runs a turn', async () => {
    const kinds = [...SUPPORTED, acpRow(FAKE)];
    assert.equal(supported('fake', kinds)?.name, 'Fake');
    assert.equal(supportedList(kinds), 'claude (Claude Code), codex (Codex), hermes (Hermes), fake (Fake)');
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${saved.PATH}`;
    const found = await harnessFinder({ dataDir: data, self: SELF }, kinds)();
    const fake = found.at(-1)!;
    assert.equal(fake.name, 'Fake');
    assert.equal((await fake.found()).path, program);
    assert.deepEqual(await fake.turn(turn()), { reply: 'It adds.' });
    await fake.end!();
  });
});
