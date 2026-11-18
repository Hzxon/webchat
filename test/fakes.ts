// Programs that stand in for the harnesses on a laptop. A harness is a process the plugin keeps for
// a session, so what a test sets in the environment per turn reaches it through a file, which each
// turn reads again (`FAKE_ENV_FILE`, written by setEnv in agent.test.ts).

/**
 * Stands in for the background Claude, a `claude -p` that reads one stream-json line for each turn:
 * logs how it was run, waits at a gate when told to, commits a file like the work of a turn, and
 * prints the lines a turn ends with. A run's first turn only checks that its card holds, and commits
 * nothing (R-042). With FAKE_CLAUDE_ASK, a list of tool calls, it asks its permission prompt tool
 * before it acts, as Claude Code does, and acts only when the answer is allow.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
// What the adapter asks of the laptop's Claude Code for Settings (D-115).
if (args[0] === '--version' || args.join(' ') === 'auth status') {
  console.log(args[0] === '--version' ? (process.env.FAKE_CLAUDE_VERSION ?? '2.1.300') + ' (Claude Code)' : '{"loggedIn": true}');
  process.exit(0);
}
const env = (name) => {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_ENV_FILE, 'utf8'))[name];
  } catch {
    return process.env[name];
  }
};
// The owner's skills it got, as a plugin folder made for the session (R-039).
const plugin = args.includes('--plugin-dir') ? fs.readdirSync(args[args.indexOf('--plugin-dir') + 1], { recursive: true }).sort() : undefined;
const resume = args.includes('--resume');
const id = args[args.indexOf(resume ? '--resume' : '--session-id') + 1];
let turns = 0;
for await (const text of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(text).message.content;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, input, cwd: process.cwd(), plugin, session: id, resumed: resume, turn: turns, pid: process.pid, mcp: args.includes('--mcp-config') ? JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) : undefined }) + '\\n');
  while (env('FAKE_CLAUDE_GATE') && !fs.existsSync(env('FAKE_CLAUDE_GATE'))) await new Promise((resolve) => setTimeout(resolve, 20));
  const check = input.includes('Change and commit nothing in this turn');
  let allowed = true;
  const calls = env('FAKE_CLAUDE_ASK') && !check && args.includes('--mcp-config') ? JSON.parse(env('FAKE_CLAUDE_ASK').replaceAll('$CWD', process.cwd())) : [];
  for (const call of calls) {
    const server = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.webchat;
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: { tool_use_id: 'toolu_fake', ...call } } };
    const res = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    const sent = await res.text();
    const data = sent.split('\\n').find((l) => l.startsWith('data: '));
    const decision = data ? JSON.parse(JSON.parse(data.slice(6)).result.content[0].text) : { status: res.status };
    fs.appendFileSync(process.env.FAKE_CLAUDE_ASKED, JSON.stringify({ call, decision }) + '\\n');
    if (decision.behavior !== 'allow') allowed = false;
  }
  if (allowed && env('FAKE_CLAUDE_FILE') && !check) fs.writeFileSync(env('FAKE_CLAUDE_FILE'), 'done\\n');
  if (env('FAKE_CLAUDE_COMMIT') !== '0' && !check && allowed) {
    const file = resume || turns > 0 ? 'sum.test.js' : 'sum.js';
    // A change of its own each turn, so a later round has something to commit.
    fs.writeFileSync(file, file + ' ' + Date.now() + '\\n');
    execFileSync('git', ['add', file]);
    execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', 'Change ' + file]);
  }
  // A turn that shows its steps (R-072): it thinks, reads a file, and runs a command with its output.
  if (env('FAKE_CLAUDE_STEPS') && !check) {
    const say = (type, content) => console.log(JSON.stringify({ type, message: { content } }));
    say('assistant', [{ type: 'thinking', thinking: 'Where is the sum?\\nIn sum.js.' }]);
    say('assistant', [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: process.cwd() + '/sum.js' } }]);
    say('assistant', [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'npm test' } }]);
    say('user', [{ type: 'tool_result', tool_use_id: 'bash1', content: 'x'.repeat(5000) + '\\n1 passing' }]);
  }
  // A work turn its owner will stop: it says what it does, twice within a second, then holds.
  if (env('FAKE_CLAUDE_HOLD') && !check) {
    const use = (name, input) => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }));
    use('Bash', { command: 'npm test', description: 'Run the tests' });
    use('Edit', { file_path: process.cwd() + '/sum.js' });
    // A minute at most, so a test that fails before the stop leaves no process behind.
    for (const until = Date.now() + 60_000; !fs.existsSync(env('FAKE_CLAUDE_HOLD')) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const answer = check
    ? JSON.parse(env('FAKE_CLAUDE_CHECK') ?? '{"outcome":"holds","note":"","checked":"Read K-7 and sum.js on main."}')
    : env('FAKE_CLAUDE_ANSWER')
      ? JSON.parse(env('FAKE_CLAUDE_ANSWER'))
      : { outcome: 'done', note: 'Sums add up now.', title: 'Fix sums', body: 'Sums were off by one.', reply: allowed ? 'It adds.' : 'Denied.' };
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: id, structured_output: answer }));
  turns++;
}
`;

/**
 * Stands in for \`codex app-server\`: JSON-RPC over lines, without the "jsonrpc" field, as Codex
 * speaks it. It logs each turn, and with FAKE_CODEX_ASK, a list of approval requests, it asks them
 * of its client before it answers, and logs what it was told.
 */
export const FAKE_CODEX = `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === '--version' || args.join(' ') === 'login status') {
  console.log(args[0] === '--version' ? 'codex-cli 0.58.0' : 'Logged in using ChatGPT');
  process.exit(process.env.FAKE_CODEX_SIGNED_OUT && args[0] === 'login' ? 1 : 0);
}
const env = (name) => {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_ENV_FILE, 'utf8'))[name];
  } catch {
    return process.env[name];
  }
};
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const answers = new Map();
let next = 1000;
const ask = (method, params) => new Promise((resolve) => {
  answers.set(next, resolve);
  send({ id: next++, method, params });
});
let thread = '0199a213-81c0-7800-8aa1-bbab2a035a53';
let turns = 0;
for await (const text of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(text);
  if (message.method === undefined) {
    answers.get(message.id)?.(message.result ?? message.error);
    continue;
  }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    thread = message.params.threadId ?? thread;
    log({ method: message.method, args, params: message.params, cwd: process.cwd() });
    send({ id: message.id, result: { thread: { id: thread } } });
  } else if (message.method === 'turn/start') {
    const turn = 'turn-' + ++turns;
    log({ method: message.method, input: message.params.input[0].text, schema: message.params.outputSchema, thread: message.params.threadId, pid: process.pid });
    // As Claude's fake does: a check turn changes nothing; with FAKE_CODEX_FILE a work turn leaves that file uncommitted, as Codex's sandbox leaves its work.
    const check = message.params.input[0].text.includes('Change and commit nothing in this turn');
    if (env('FAKE_CODEX_FILE') && !check) fs.writeFileSync(env('FAKE_CODEX_FILE'), 'done\\n');
    const said = (check && env('FAKE_CODEX_CHECK')) || env('FAKE_CODEX_ANSWER') || '{"reply":"It adds.","drafts":null}';
    const started = { id: message.id, result: { turn: { id: turn } } };
    // With nothing to ask, the turn's answer, its message and its end go in one write, as Linux delivers
    // them in one read: the client must not drop an end that comes before it knows the turn's id.
    if (!env('FAKE_CODEX_ASK')) {
      const answer = { method: 'item/completed', params: { threadId: thread, turnId: turn, item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: said } } };
      const end = { method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: env('FAKE_CODEX_FAIL') ? 'failed' : 'completed', ...(env('FAKE_CODEX_FAIL') && { error: { message: env('FAKE_CODEX_FAIL') } }) } } };
      process.stdout.write([started, answer, end].map((m) => JSON.stringify(m)).join('\\n') + '\\n');
      continue;
    }
    send(started);
    // Not awaited: the client's answer is the next line, which this loop must go on to read.
    void (async () => {
    for (const request of env('FAKE_CODEX_ASK') ? JSON.parse(env('FAKE_CODEX_ASK')) : []) {
      if (request.method === 'item/fileChange/requestApproval') send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { type: 'fileChange', id: request.params.itemId, changes: request.changes } } });
      const decision = await ask(request.method, { threadId: thread, turnId: turn, ...request.params });
      log({ asked: request.method, decision });
    }
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { type: 'agentMessage', id: 'm1', phase: 'final_answer', text: said } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: env('FAKE_CODEX_FAIL') ? 'failed' : 'completed', ...(env('FAKE_CODEX_FAIL') && { error: { message: env('FAKE_CODEX_FAIL') } }) } } });
    })();
  }
}
`;
