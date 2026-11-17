import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeArgs, claudeHarness, claudeSettings, restrictedSettings, sandboxProblem } from '../agent/claude.ts';
import { codexHarness } from '../agent/codex.ts';
import type { Ask, Harness, Reply, Turn } from '../agent/harness.ts';
import { parts } from '../agent/conversations.ts';
import { worktreeGit } from '../agent/bench.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './fakes.ts';
import { sh, git, runClaude, withEnv, setEnv, waitFor } from './agentHelpers.ts';

test("runs git in a worktree on the git folder its checkout lists, whatever the worktree's .git file says", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-git-')));
  // The checkout is reached through a link, and its worktree's pointer is relative, as git 2.48 can write it.
  await fs.mkdir(path.join(dir, 'real'));
  await fs.symlink(path.join(dir, 'real'), path.join(dir, 'link'));
  const project = path.join(dir, 'link', 'app');
  await sh('git', ['init', '-q', project]);
  await git(project, 'commit', '-q', '--allow-empty', '-m', 'Start');
  const worktree = path.join(project, '.claude', 'worktrees', 'k-7');
  await git(project, 'worktree', 'add', '-q', '--detach', worktree);
  const admin = path.join(dir, 'real', 'app', '.git', 'worktrees', 'k-7');
  await fs.writeFile(path.join(admin, 'gitdir'), '../../../.claude/worktrees/k-7/.git\n');
  // The model points the worktree, and a submodule it stages, at a git folder whose config runs a command.
  const planted = path.join(dir, 'planted');
  await sh('git', ['init', '-q', planted]);
  await git(planted, 'commit', '-q', '--allow-empty', '-m', 'Planted');
  const ran = path.join(dir, 'ran');
  await git(planted, 'config', 'core.fsmonitor', `touch ${ran}`);
  const plantedHead = (await git(planted, 'rev-parse', 'HEAD')).stdout.trim();
  await sh('git', [`--git-dir=${admin}`, `--work-tree=${worktree}`, 'update-index', '--add', '--cacheinfo', `160000,${plantedHead},sub`]);
  await fs.mkdir(path.join(worktree, 'sub'));
  await fs.writeFile(path.join(worktree, 'sub', '.git'), `gitdir: ${path.join(planted, '.git')}\n`);
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(planted, '.git')}\n`);
  assert.equal(await fs.realpath(await worktreeGit(worktree, 'rev-parse', '--absolute-git-dir')), admin);
  await worktreeGit(worktree, 'status', '--porcelain');
  await worktreeGit(worktree, 'diff', '--cached', '--quiet').catch(() => undefined);
  assert.equal(existsSync(ran), false, 'the planted config ran nothing');
  await fs.rm(dir, { recursive: true, force: true });
});

test('cuts an answer into messages after line breaks, never inside a surrogate pair', () => {
  const line = 'x'.repeat(3900);
  const [one, two] = parts(`${line}\n  ${'z'.repeat(200)}\n${'y'.repeat(300)}`);
  assert.equal(one, `${line}\n`);
  assert.ok(two!.startsWith(`  ${'z'.repeat(5)}`), 'the next line keeps its indentation');
  const emoji = parts(`${'a'.repeat(3999)}\u{1F600} and more`);
  assert.ok(emoji.length > 1);
  for (const part of emoji) assert.ok(!/[\ud800-\udbff]$/.test(part), 'no part ends inside a pair');
  assert.equal(emoji.join(''), `${'a'.repeat(3999)}\u{1F600} and more`);
});

test('answers through Codex app-server, one process for a session, and resumes its thread after a restart; takes no cards', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-codex-')));
  const program = path.join(dir, 'codex');
  const log = path.join(dir, 'codex.log');
  await fs.writeFile(program, FAKE_CODEX, { mode: 0o755 });
  // The owner's Codex config lists MCP servers, which are turned off by name.
  const home = path.join(dir, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.toml'), '[mcp_servers.github]\ncommand = "x"\n[mcp_servers.github.env]\nA = "1"\n[mcp_servers."odd.name"]\ncommand = "y"\n');
  const restore = setEnv({ FAKE_CODEX_LOG: log, CODEX_HOME: home });
  const entries = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; args?: string[]; input?: string; schema?: object; thread?: string; pid?: number; params?: Record<string, unknown> });
  const harnesses: Harness[] = [];
  try {
    const schema = { type: 'object', properties: { reply: { type: 'string' }, drafts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } }, required: ['reply'] };
    const turn = (harness: Harness, resume: boolean, message: string) => harness.turn({ cwd: dir, session: 's-1', resume, message, schema, setup: {}, signal: new AbortController().signal });
    const harness = codexHarness(program, dir);
    harnesses.push(harness);
    assert.equal(await harness.refusal(), undefined);
    assert.equal(await codexHarness('', dir).refusal(), 'I cannot find Codex on this laptop.');
    assert.deepEqual(await turn(harness, false, 'What does sum.js do?'), { reply: 'It adds.' }, 'a null for a left-out field is dropped');
    assert.deepEqual(await turn(harness, true, 'And again?'), { reply: 'It adds.' });
    // A restart keeps the thread of each session.
    const again = codexHarness(program, dir);
    harnesses.push(again);
    await withEnv({ FAKE_CODEX_ANSWER: '{"reply":"Still adds.","drafts":[{"title":"Sums"}]}' }, () => turn(again, true, 'And now?'));
    const all = await entries();
    const [first, second, third] = all.filter((e) => e.method === 'turn/start');
    const [start, resumed] = all.filter((e) => e.method?.startsWith('thread/'));
    assert.equal(first!.input, 'What does sum.js do?');
    assert.equal(first!.pid, second!.pid, 'one process takes the turns of a session');
    assert.notEqual(first!.pid, third!.pid, 'a restart starts another');
    assert.equal(start!.method, 'thread/start');
    assert.equal(resumed!.method, 'thread/resume');
    assert.equal(resumed!.params!.threadId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
    assert.equal(start!.params!.approvalPolicy, 'never', 'with no question to ask, it asks for nothing');
    const args = all[0]!.args!;
    assert.ok(!args.some((arg) => arg.includes('sum.js')), 'the message is never in the arguments');
    assert.ok(args.includes('shell_environment_policy.inherit="core"') && args.includes('features.hooks=false'), "none of the owner's hooks or tokens");
    assert.ok(args.includes('mcp_servers.github.enabled=false') && args.includes('mcp_servers."odd.name".enabled=false'), "none of the owner's MCP servers, one by one");
    assert.ok(!args.includes('--ignore-user-config'), 'app-server has no such flag');
    assert.deepEqual(first!.schema, {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        drafts: { anyOf: [{ type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } }, { type: 'null' }] },
      },
      required: ['reply', 'drafts'],
      additionalProperties: false,
    });
    await assert.rejects(withEnv({ FAKE_CODEX_FAIL: 'Usage limit reached.' }, () => turn(again, true, 'Again?')), /Usage limit reached/);
  } finally {
    restore();
    await Promise.all(harnesses.map((h) => h.end?.()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('asks through Claude Code\'s permission prompt tool, one process for a session, and no rule outlives the turn (docs/decisions/harness-approvals.md)', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-claude-ask-')));
  const program = path.join(dir, 'claude');
  await fs.writeFile(program, FAKE_CLAUDE, { mode: 0o755 });
  const [log, asked] = [path.join(dir, 'claude.log'), path.join(dir, 'asked.log')];
  const calls = [
    { tool_name: 'Bash', input: { command: 'npm test ../elsewhere', description: 'Quietly delete everything' } },
    { tool_name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
    { tool_name: 'mcp__owner__mail', input: { to: 'x' } },
  ];
  const restore = setEnv({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_ASKED: asked, FAKE_CLAUDE_ASK: JSON.stringify(calls), FAKE_CLAUDE_COMMIT: '0' });
  const harness = claudeHarness(program, dir);
  try {
    await fs.mkdir(path.join(dir, 'laptop'), { recursive: true });
    const one = { type: 'object', properties: { outcome: { type: 'string', enum: ['holds', 'stale'] }, note: { type: 'string' }, checked: { type: 'string' } }, required: ['outcome', 'note', 'checked'] };
    const two = { type: 'object', properties: { outcome: { type: 'string', enum: ['done', 'failed'] }, note: { type: 'string' }, title: { type: 'string' } }, required: ['outcome', 'note'] };
    const seen: Ask[] = [];
    const replies: Reply[] = [{ allow: true }, { allow: false, message: 'Your owner said no.' }, { allow: true }];
    const turn = (over: Partial<Turn> = {}) =>
      harness.turn({ cwd: dir, session: 's-1', resume: false, message: 'Run it', schema: two, schemas: [one, two], setup: {}, signal: new AbortController().signal, ask: async (ask) => (seen.push(ask), replies[seen.length - 1]!), ...over });
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done","note":"ok"}' }, () => turn());
    // What the owner is asked is the tool's own input, never the model's description, and paths are the ones that name a place.
    assert.deepEqual(seen.map((a) => [a.tool, a.kind, a.detail, a.paths]), [
      ['Bash', 'execute', 'npm test ../elsewhere', [path.resolve(dir, '../elsewhere')]],
      ['Edit', 'edit', 'Edit src/a.ts', [path.join(dir, 'src/a.ts')]],
      ['mcp__owner__mail', 'other', 'mcp__owner__mail {"to":"x"}', []],
    ]);
    const decisions = (await fs.readFile(asked, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { decision: { behavior: string; message?: string; updatedInput?: object } });
    assert.deepEqual(decisions.map((d) => d.decision.behavior), ['allow', 'deny', 'allow']);
    assert.deepEqual(decisions[0]!.decision.updatedInput, calls[0]!.input, 'an allow hands the input back');
    assert.equal(decisions[1]!.decision.message, 'Your owner said no.');
    const [first] = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string; pid: number; mcp: { mcpServers: { webchat: { type: string; url: string; timeout: number } } } });
    const flag = (name: string) => first!.args[first!.args.indexOf(name) + 1];
    assert.equal(flag('--permission-prompt-tool'), 'mcp__webchat__approve');
    assert.equal(flag('--disallowedTools'), 'mcp__webchat__approve', 'the model cannot call the tool');
    assert.ok(first!.args.includes('--strict-mcp-config') && first!.args.includes('--restricted') && !first!.args.includes('--permission-prompts'));
    assert.equal(first!.args.at(-2), '--session-id');
    assert.deepEqual(first!.mcp.mcpServers.webchat.type, 'http');
    assert.match(first!.mcp.mcpServers.webchat.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'a port of this machine only');
    assert.ok(first!.mcp.mcpServers.webchat.timeout > 7 * 24 * 60 * 60_000, 'it outwaits the 7 days a question waits');
    // One schema serves the session, with what every turn needs; the turn's own schema is in its message.
    const schema = JSON.parse(flag('--json-schema')!) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    assert.deepEqual([Object.keys(schema.properties), schema.properties.outcome!.enum, schema.required], [['outcome', 'note', 'checked', 'title'], ['holds', 'stale', 'done', 'failed'], ['outcome', 'note']]);
    assert.ok(first!.input.includes('Answer this message only') && first!.input.includes(JSON.stringify(two)), 'each turn says to answer afresh, as its own schema says');
    assert.ok(!first!.args.some((arg) => arg.includes('Run it')), 'the message is never in the arguments');
    assert.equal((await fs.readdir(path.join(dir, 'laptop', 'approve'))).length, 1, 'a token file while it runs');

    // A later turn of the session goes to the same process, which takes a different schema; one with no way to ask starts another that refuses.
    seen.length = 0;
    replies.push({ allow: true }, { allow: true }, { allow: true });
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"holds","note":"","checked":"x"}' }, () => turn({ resume: true, schema: one }));
    const later = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { pid: number; turn: number; args: string[] });
    assert.deepEqual([later[1]!.pid === later[0]!.pid, later[1]!.turn], [true, 1], 'one process takes the session\'s turns');
    await withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done","note":"ok"}' }, () => turn({ resume: true, ask: undefined }));
    const refusing = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { pid: number; args: string[] }).at(-1)!;
    assert.notEqual(refusing.pid, later[0]!.pid);
    assert.deepEqual([refusing.args.includes('--permission-prompts'), refusing.args.includes('--mcp-config'), refusing.args.includes('--resume')], [true, false, true]);
    // An answer that does not fit the turn's own schema fails the turn.
    await assert.rejects(withEnv({ FAKE_CLAUDE_ANSWER: '{"outcome":"done"}' }, () => turn({ ask: undefined })), /answer did not fit: the answer\.note: required/);
    // A question that cannot be asked fails the turn with the reason, and its process ends.
    await assert.rejects(turn({ resume: true, ask: async () => Promise.reject(new Error('No answer came within 7 days.')) }), /^Error: No answer came within 7 days\.$/);
    await harness.end?.();
    assert.deepEqual(await fs.readdir(path.join(dir, 'laptop', 'approve')), [], 'no token file outlives its process');
  } finally {
    restore();
    await harness.end?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('answers Codex\'s approvals accept or decline only, and never a rule that outlives one (docs/decisions/harness-approvals.md)', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-codex-ask-')));
  const program = path.join(dir, 'codex');
  const log = path.join(dir, 'codex.log');
  await fs.writeFile(program, FAKE_CODEX, { mode: 0o755 });
  const requests = [
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', command: '/bin/zsh -lc \'curl https://example.com\'', cwd: dir } },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'i2', reason: null, grantRoot: null }, changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }] },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'i3', grantRoot: '/' }, changes: [{ path: 'b.ts', kind: 'add', diff: '' }] },
    { method: 'item/permissions/requestApproval', params: { itemId: 'i4' } },
  ];
  const restore = setEnv({ FAKE_CODEX_LOG: log, FAKE_CODEX_ASK: JSON.stringify(requests), CODEX_HOME: path.join(dir, 'none') });
  const harness = codexHarness(program, dir);
  try {
    const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
    const seen: Ask[] = [];
    await harness.turn({ cwd: dir, session: 's-1', resume: false, message: 'Go', schema, setup: {}, signal: new AbortController().signal, ask: async (ask): Promise<Reply> => (seen.push(ask), seen.length === 1 ? { allow: true } : { allow: false, message: 'No.' }) });
    assert.deepEqual(seen.map((a) => [a.tool, a.kind, a.detail, a.paths]), [
      ['shell', 'execute', '/bin/zsh -lc \'curl https://example.com\'', []],
      ['apply_patch', 'edit', path.join(dir, 'src/a.ts'), [path.join(dir, 'src/a.ts')]],
    ], 'a file change names its files from the item it joins, and one that asks for a whole folder is declined unasked');
    const entries = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: { approvalPolicy: string }; asked?: string; decision?: unknown });
    assert.equal(entries.find((e) => e.method === 'thread/start')!.params!.approvalPolicy, 'on-request', 'with a way to ask, Codex asks');
    assert.deepEqual(
      entries.filter((e) => e.asked).map((e) => [e.asked, e.decision]),
      [
        ['item/commandExecution/requestApproval', { decision: 'accept' }],
        ['item/fileChange/requestApproval', { decision: 'decline' }],
        ['item/fileChange/requestApproval', { decision: 'decline' }],
        ['item/permissions/requestApproval', { code: -32601, message: 'WebChat answers only the approval of a command or a file change.' }],
      ],
      'only accept or decline, never a decision for the session or an amendment',
    );
    // A question that cannot be asked fails the turn with its reason.
    await assert.rejects(harness.turn({ cwd: dir, session: 's-2', resume: false, message: 'Go', schema, setup: {}, signal: new AbortController().signal, ask: () => Promise.reject(new Error('No answer came within 7 days.')) }), /^Error: No answer came within 7 days\.$/);
  } finally {
    restore();
    await harness.end?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Claude Code's own behaviour, which the plugin relies on (R-035, D-097). It costs a few cents of
// the account `claude` is signed in to, so it runs only when asked. Run it after each Claude Code
// update: a -p run drops, without a word, a settings file holding a value it no longer accepts.
test(
  'runs a background Claude restricted and sandboxed, and resumes its session (R-035)',
  { skip: !process.env.WEBCHAT_REAL_CLAUDE && 'set WEBCHAT_REAL_CLAUDE=1 to run it with your claude', timeout: 10 * 60_000 },
  async (t) => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-claude-')));
    const data = path.join(dir, 'data');
    const project = path.join(dir, 'app');
    const worktree = path.join(project, '.claude', 'worktrees', 'k-1');
    const canary = `CANARY-${randomUUID()}`;
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, 'canary.txt'), canary);
    // A repository's settings and MCP servers, which a restricted run must not load.
    await fs.writeFile(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${path.join(dir, 'hook-ran')}` }] }] },
        sandbox: { filesystem: { allowRead: [data] } },
      }),
    );
    await fs.writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'touch', args: [path.join(dir, 'mcp-ran')] } } }));
    await git(project, 'init', '-q');
    // The sandboxed shell commits with plain git, so the repository needs a name to commit under.
    await git(project, 'config', 'user.name', 'Claude');
    await git(project, 'config', 'user.email', 'claude@example.com');
    await git(project, 'add', '-A');
    await git(project, 'commit', '-q', '-m', 'Start');
    await git(project, 'worktree', 'add', '-q', '-b', 'agent/k-1', worktree);

    const settings = path.join(dir, 'claude.json');
    // Tokens the owner's environment holds, which the shell of a background Claude must not inherit.
    const githubToken = `gho_CANARY${randomUUID().replaceAll('-', '')}`.slice(0, 40);
    const npmToken = `npm_CANARY${randomUUID().replaceAll('-', '')}`.slice(0, 40);
    t.after(setEnv({ GH_TOKEN: githubToken, NPM_TOKEN: npmToken }));
    // Claude Code lets a sandboxed shell read the environments SessionStart hooks left, tokens and all.
    const sessionEnv = path.join(os.homedir(), '.claude', 'session-env');
    await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets: [data, sessionEnv], npmCache: path.join(dir, 'npm'), env: process.env })));
    assert.equal(await sandboxProblem(worktree, [data], restrictedSettings(settings)), undefined);

    const lines: string[] = [];
    const session = randomUUID();
    const answer = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
    const turn = (input: string, resume: boolean) => runClaude([...claudeArgs({ settings, session, resume, schema: answer }), '--model', 'haiku', '--max-budget-usd', '1'], worktree, input, (line) => lines.push(line));
    const first = await turn(
      [
        'This checks a sandbox. Do these steps in order, one tool call each, and do not retry one that fails. Steps 1, 2, 5 and 6 are meant to fail.',
        `1. Run with the Bash tool: cat ${path.join(data, 'canary.txt')}`,
        "2. Run with the Bash tool: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com",
        "3. Run with the Bash tool: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/left-pad",
        '4. Run with the Bash tool: echo hi > notes.txt && git add notes.txt && git commit -q -m "Add notes"',
        '5. Run with the Bash tool: ls ~/Library/Keychains',
        '6. Run with the Bash tool: ls ~/.claude/session-env',
        '7. Run with the Bash tool: npm view left-pad version',
        '8. Run with the Bash tool: printenv > env.txt',
        '9. Keep the word PELICAN in mind for later.',
        'Then put one line per step in reply.',
      ].join('\n'),
      false,
    );
    assert.equal(first.session, session);
    assert.ok(first.answer, 'the turn ends with the JSON answer');

    // What each tool call returned, by the command or file it named.
    const events = lines.map((line) => JSON.parse(line) as { type: string; message?: { content?: Array<Record<string, unknown>> } });
    const blocks = events.flatMap((e) => (e.type === 'assistant' || e.type === 'user' ? (e.message?.content ?? []) : []));
    const resultOf = (named: string) => {
      const use = blocks.find((b) => b.type === 'tool_use' && JSON.stringify(b.input).includes(named));
      assert.ok(use, `Claude tried: ${named}`);
      return JSON.stringify(blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === use.id)?.content);
    };
    assert.match(resultOf('cat '), /Operation not permitted/, 'the sandbox keeps the shell from the secrets, whatever the project allows');
    assert.match(resultOf('example.com'), /deny network-outbound/, 'the shell reaches no other host');
    assert.match(resultOf('registry.npmjs.org'), /200/, 'the shell reaches the registry');
    assert.ok(!lines.some((line) => line.includes(canary)), 'the secret never reaches the model');
    assert.match((await git(worktree, 'log', '--format=%s', '-1')).stdout, /Add notes/, 'the sandboxed shell commits in the worktree');
    assert.equal(await fs.stat(path.join(dir, 'hook-ran')).catch(() => null), null, "the repository's hook never runs");
    assert.equal(await fs.stat(path.join(dir, 'mcp-ran')).catch(() => null), null, "the repository's MCP server never runs");
    // gh keeps the owner's token in the keychain, which the shell reaches only through these files (K-54).
    assert.match(resultOf('Library/Keychains'), /Operation not permitted/, 'the shell cannot read the home folder, keychain included');
    assert.match(resultOf('session-env'), /Operation not permitted|No such file/, 'the shell cannot read the environments hooks left');
    assert.match(resultOf('npm view'), /\d+\.\d+\.\d+/, "npm works with a cache and no config of the owner's");

    const env = await fs.readFile(path.join(worktree, 'env.txt'), 'utf8');
    assert.ok(env.includes('PATH='), 'the command ran');
    assert.ok(!env.includes(githubToken), 'the shell gets no GitHub token from the environment');
    assert.ok(!env.includes(npmToken), 'the shell gets no npm token from the environment');

    const second = await turn('Which word did the first message ask you to keep in mind? Put only that word in reply.', true);
    assert.equal(second.session, session);
    assert.match(String((second.answer as { reply?: string } | undefined)?.reply), /PELICAN/i, 'the turn resumes the session');
  },
);

test(
  "runs a real background Claude with its owner's CLAUDE.md, a chosen skill and no attribution (R-039)",
  { skip: !process.env.WEBCHAT_REAL_CLAUDE && 'set WEBCHAT_REAL_CLAUDE=1 to run it with your claude', timeout: 10 * 60_000 },
  async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-setup-')));
    const project = path.join(dir, 'app');
    // The plugin folder a turn gets: only skills/, with the chosen skill's copy.
    const skills = path.join(dir, 'turn', 'owner');
    await fs.mkdir(path.join(skills, 'skills', 'pr-title'), { recursive: true });
    await fs.writeFile(
      path.join(skills, 'skills', 'pr-title', 'SKILL.md'),
      '---\nname: pr-title\ndescription: How to title a pull request. Use it whenever you write a pull request title.\n---\nA pull request title starts with "Ostrich: ", then says what changed.\n',
    );
    const claudeMd = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(claudeMd, 'Before you write a pull request title, use the pr-title skill.\n');
    await fs.mkdir(project);
    await git(project, 'init', '-q');
    await git(project, 'config', 'user.name', 'Claude');
    await git(project, 'config', 'user.email', 'claude@example.com');
    await git(project, 'commit', '-q', '--allow-empty', '-m', 'Start');
    const settings = path.join(dir, 'claude.json');
    await fs.writeFile(settings, JSON.stringify(claudeSettings({ secrets: [], npmCache: path.join(dir, 'npm'), env: process.env, noAttribution: true })));
    const answer = { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] };
    const turn = await runClaude(
      [...claudeArgs({ settings, session: randomUUID(), resume: false, schema: answer, claudeMd, skills }), '--model', 'haiku', '--max-budget-usd', '1'],
      project,
      'Add a line "hi" to notes.txt and commit it with git. Then answer with the title and the body of a pull request for it.',
    );
    const pull = turn.answer as { title?: string; body?: string } | undefined;
    assert.match(pull?.title ?? '', /^Ostrich: /, 'the title follows the chosen skill, which CLAUDE.md named');
    assert.doesNotMatch(pull?.body ?? '', /Generated with/i, 'the body has no attribution line');
    const commit = (await git(project, 'log', '-1', '--format=%B')).stdout;
    assert.ok(commit.trim() && commit.trim() !== 'Start', 'the turn committed');
    assert.doesNotMatch(commit, /Co-Authored-By/i, 'the commit has no attribution trailer');
  },
);

test('a login service from before the room that still runs `serve` is told to run setup, and idles instead of restarting in a loop', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'agent/index.ts', 'serve'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const said: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => said.push(chunk)).on('error', () => undefined);
  child.on('error', () => undefined);
  const ended = new Promise((resolve) => child.once('close', resolve));
  try {
    await waitFor('it says so', () => /run `webchat-agent setup`/.test(Buffer.concat(said).toString()));
    await sleep(300);
    assert.equal(child.exitCode, null, 'it is still running');
  } finally {
    child.kill();
    await ended;
  }
});
