import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeResult } from '../agent/claude.ts';
import { AgentClient } from '../agent/client.ts';
import { repoHome } from '../agent/keep.ts';
import type { Final } from '../agent/runner.ts';
import { newChatKeyBytes, newKeyId, pairingId, pairingProof, wrapChatKey } from '../shared/e2ee.ts';
import type { DocDTO, FirstChatKeyInput, PairingDTO, RunDTO, RunRequest, UserDTO } from '../shared/types.ts';
import { fakeRoom, testLayout } from './fakeRoom.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './fakes.ts';
import type { Server } from 'node:http';
import type { WebChatApp } from '../server/app.ts';

/** What the tests in one agent run share, which the first test sets up and the later ones use, in order. */
export interface World {
  instance: WebChatApp;
  server: Server;
  baseUrl: string;
  home: string;
  alice: AgentClient;
  bot: AgentClient;
  carol: AgentClient;
  botFile: string;
  projectId: number;
  generalId: number;
  roadmap: DocDTO;
  cardId: string;
  cardText: string;
  /** A request for K-1, as the owner's page sends it. */
  runOf: (extra?: Partial<RunRequest>) => Promise<RunDTO>;
  /** A second card, which the K-51 test puts on the board, to run beside K-1 (R-037). */
  k2: string;
  k2Text: string;
  runOfK2: () => Promise<RunDTO>;
}


// The server never sees how the login key was derived, so fewer PBKDF2 rounds keep tests fast.
export const KDF_ROUNDS = 1000;
export const sh = promisify(execFile);
export const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, '-c', 'user.name=Claude', '-c', 'user.email=claude@example.com', ...args]);
/** The mark that the owner's approval writes when they connect a folder (docs/decisions/connect-approval.md). */
export const markFile = (dataDir: string, repo: string) => path.join(repoHome(dataDir, repo), 'connected');
export const connect = async (dataDir: string, repo: string, dir: string) => {
  await fs.mkdir(path.dirname(markFile(dataDir, repo)), { recursive: true });
  await fs.writeFile(markFile(dataDir, repo), dir);
};
export const disconnect = (dataDir: string, repo: string) => fs.rm(markFile(dataDir, repo), { force: true });

/**
 * Stands in for GitHub's command line: opens pull requests into a JSON file, and answers for them
 * with what the test put there, the head commit read from the bare repository.
 */
export const FAKE_GH = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (args[0] === 'pr' && args[1] === 'create') {
  state.pulls.push({ head: flag('--head'), base: flag('--base'), draft: args.includes('--draft'), title: flag('--title'), body: flag('--body') });
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  console.log('https://github.com/' + flag('--repo') + '/pull/' + state.pulls.length);
} else if (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'close')) {
  // What the plugin changed later, beside what it opened the pull request with.
  const pull = state.pulls[Number(args[2]) - 1];
  if (args[1] === 'close') pull.closed = flag('--comment');
  else pull.edited = { title: flag('--title'), body: flag('--body') };
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const pull = state.pulls[Number(args[2]) - 1];
  const head = execFileSync('git', ['--git-dir', state.origin, 'rev-parse', 'refs/heads/' + pull.head], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ state: 'OPEN', isDraft: true, headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [], reviews: [], comments: [], ...pull.view }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  // The pull requests the test opened, and the drafts the plugin opened, each on its head.
  const all = [...(state.open ?? []), ...state.pulls.map((p, i) => ({ number: i + 1, title: '', headRefName: p.head }))];
  console.log(JSON.stringify(all.filter((p) => !args.includes('--head') || p.headRefName === flag('--head'))));
} else if (args[0] === 'run') {
  console.log('FAIL test/sum.test.js: expected 3, got 4');
} else if (args[0] === 'api') {
  console.log(args[1].endsWith('/permission') ? '{"permission":"write"}' : '[]');
}
`;
export const PASSWORD = 'correct horse battery';

/** A fresh chat key, wrapped by this client for each member, as a browser does when it makes a project. */
export async function newChatKey(client: AgentClient, memberIds: number[]): Promise<FirstChatKeyInput> {
  const raw = newChatKeyBytes();
  const keyId = newKeyId();
  const { id: conversationId } = await client.request<{ id: number }>('POST', '/conversations/ids');
  const me = { id: client.id, identity: client.identity };
  const wrappedKeys = await Promise.all(
    memberIds.map(async (id) => ({ id, ...(await wrapChatKey(raw, me, { id, dh: client.keysOf(id)!.dh }, keyId, conversationId)) })),
  ).then((keys) => keys.map(({ id, ...k }) => ({ userId: id, ...k })));
  return { conversationId, keyId, wrappedKeys };
}

/** One turn of the real `claude` with the adapter's arguments: its stream-json line on stdin, then the end of stdin, which ends the process. */
export async function runClaude(args: string[], cwd: string, input: string, seen: (line: string) => void = () => undefined) {
  const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], signal: AbortSignal.timeout(5 * 60_000) });
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: input } })}\n`);
  let last: Final | undefined;
  for await (const line of readline.createInterface({ input: child.stdout })) {
    seen(line);
    last = claudeResult(line) ?? last;
  }
  assert.ok(last, 'the turn ends with a result');
  return last;
}

/** Does `work` with these environment variables set, then puts back what was there. */
export async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T>) {
  const restore = setEnv(vars);
  try {
    return await work();
  } finally {
    restore();
  }
}

// The fake harnesses are processes the plugin keeps for a session, so they read what a test sets per turn from this file.
process.env.FAKE_ENV_FILE = path.join(os.tmpdir(), `webchat-fake-env-${process.pid}.json`);
export const syncFakes = () => writeFileSync(process.env.FAKE_ENV_FILE!, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('FAKE_')))));

/** Sets environment variables, and returns how to put back what was there. */
export function setEnv(vars: Record<string, string>) {
  const saved = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  syncFakes();
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    syncFakes();
  };
}

/** Waits up to 10 seconds for something the plugin does on its own, then checks it. */
export async function waitFor(what: string, done: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 1000 && !(await done()); tries++) await sleep(10);
  assert.ok(await done(), what);
}

/**
 * Plays the owner's page in a pairing: waits for the agent's half, checks its keys against the
 * code, and approves with the owner's keys bound to the code, as AgentDialog does.
 */
export async function approve(owner: AgentClient, code: string, displayName: string, proof?: string) {
  const id = await pairingId(code);
  let pairing: PairingDTO | undefined;
  while (!(pairing = await owner.api.request<PairingDTO | undefined>('GET', `/pairings/${id}`))) await sleep(10);
  assert.equal(pairing.proof, await pairingProof(code, pairing.keys), 'the keys came with the code');
  proof ??= await pairingProof(code, pairing.keys, { id: owner.id, keys: owner.identity.publicKeys });
  return owner.request<UserDTO>('POST', `/pairings/${id}/approve`, { displayName, proof });
}

/**
 * A laptop for setup to run on: fakes for the service tools and the harnesses it asks of, a room that
 * touches nothing real, and an environment that points at them. `restore` puts the environment back.
 */
export async function fakeLaptop(dir: string) {
  const [bin, laptopHome, agentHome, log, ghState] = ['bin', 'home', 'home/.webchat', 'services.log', 'gh.json'].map((name) => path.join(dir, name));
  await fs.mkdir(bin);
  await fs.mkdir(laptopHome);
  await fs.writeFile(ghState, JSON.stringify({ pulls: [] }));
  const fake = (name: string, body: string) => fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
  // One script stands in for launchctl and systemctl: it logs what it was asked and says the service runs.
  const service = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\ncase "$*" in *"print "*) echo "state = running";; *is-active*) echo active;; esac\n`;
  for (const name of ['launchctl', 'systemctl']) await fake(name, service);
  // Everything the laptop would need is there, so setup installs nothing and runs no sudo.
  for (const name of ['git', 'xcode-select', 'bwrap', 'socat']) await fake(name, '#!/bin/sh\n');
  await fake('id', '#!/bin/sh\necho "$FAKE_GROUPS"\n');
  await fake('gh', FAKE_GH);
  await fake('claude', FAKE_CLAUDE);
  await fake('codex', FAKE_CODEX);
  await fake('shell', `#!/bin/sh\nprintf '%s%s%s' __webchat_path__ "$PATH" __webchat_path__\n`);
  const restore = setEnv({
    HOME: laptopHome,
    XDG_CONFIG_HOME: path.join(laptopHome, '.config'),
    SHELL: path.join(bin, 'shell'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_STATE: ghState,
    FAKE_GROUPS: 'staff admin sudo',
  });
  const program = path.join(dir, 'webchat-agent');
  await fs.writeFile(program, 'the program', { mode: 0o755 });
  const layout = testLayout(dir, path.join(bin, 'git'));
  const unitFile = process.platform === 'darwin' ? path.join(laptopHome, 'Library/LaunchAgents/webchat-agent.plist') : path.join(laptopHome, '.config/systemd/user/webchat-agent.service');
  return { bin, laptopHome, agentHome, log, restore, program, layout, room: fakeRoom(layout), unitFile };
}

