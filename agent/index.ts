// The agent daemon's command line (R-027): the host for a laptop without Claude Code, which serves the
// same Plugin as agent/mcp.ts, in the folder `laptop` of the agent home. `setup` installs a login
// service that keeps `serve` running (agent/setup.ts), and `doctor`, `status` and `uninstall` go with it.
// `sleep` and `wake` do what the /webchat: skills do. `connect` asks the owner to connect the folder you
// run it in, and marks it when they approve in WebChat. `link` asks the owner to link a harness, which they approve in WebChat.
// These commands ask the keyholder over its socket (agent/room.ts). `keyholder` serves the keys and `runner` works in the
// owner's folders for it; `serve` does both in one process, as does `dev`, which uses a socket of its own.
// `pair <code> <name>` makes an account of its own, which `serve` does not use unless its name is `laptop`. `pair` alone is
// setup's, run by sudo as the role account with the code on stdin. `setup` builds the room that `keyholder` and `runner` run in.
//
//   npm run agent -- serve|keyholder|dev [code]
//   npm run agent -- runner
//   npm run agent -- connect|sleep|wake
//   npm run agent -- link claude|codex
//   npm run agent -- pair <code> <name>
//
// Each release also ships it as one file per OS, webchat-agent, with Node inside (agent/sea.json),
// which takes the same commands, `setup [code]`, `doctor`, `status`, `uninstall` and `--version`.
//
// The code comes from Connect coding agent in WebChat (R-030). Accounts live under
// WEBCHAT_AGENT_HOME, by default ~/.webchat, one folder per name.
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import type { PairingPick } from '../shared/types.ts';
import { runAnswerServer } from './answer.ts';
import { runGuard } from './claude.ts';
import { harnessFinder, supported, supportedList } from './harnesses.ts';
import { LocalBench } from './bench.ts';
import { layoutFor, socketOf } from './lockroom.ts';
import { NO_REPOSITORY, Plugin } from './plugin.ts';
import { callRoom, Room, runRunner } from './room.ts';
import { doctor, pairInto, setup, status, uninstall } from './setup.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const fileFor = (name: string) => path.join(home, name, 'account.json');
const cli = isSea() ? 'webchat-agent' : 'npm run agent --';
// The guard hook runs this program again: the single file, or this script through tsx.
const self = isSea() ? `"${process.execPath}"` : `"${process.execPath}" --import "${import.meta.resolve('tsx')}" "${fileURLToPath(import.meta.url)}"`;

/** `serve`, which a laptop set up before the room still runs, keeps its socket in the agent home. */
const legacySocket = path.join(home, 'keyholder.sock');
/** Where the commands find the keyholder: the folder setup makes (docs/decisions/locked-room.md), or `serve`'s socket on a laptop that has none yet. */
const socketFile = () => process.env.WEBCHAT_SOCKET ?? (existsSync(layoutFor('darwin').ipc) || existsSync(layoutFor('linux').ipc) || !existsSync(legacySocket) ? socketOf(layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux')) : legacySocket);
const dataDir = path.join(home, 'laptop');
const finder = () => harnessFinder({ hook: `${self} guard "${dataDir}"`, dataDir });

/** What works in the owner's folders, for the runner: the harnesses and the owner's setup (D-085). */
async function runner(file: string) {
  // The runner's own files, apart from the keyholder's `laptop` that a laptop from before the room still has.
  const runnerDir = path.join(home, 'runner');
  const find = harnessFinder({ hook: '', dataDir: runnerDir });
  return runRunner({ file, bench: new LocalBench(await find(), find, runnerDir), version: pkg.version, say: console.error });
}

/**
 * The keyholder: the Plugin, serving the commands on a socket. `socket` has it ask a runner for all
 * that happens in the owner's folders; `inline`, which `serve` is, does that in this process.
 */
async function keyholder(code: string, file: string, mode: 'inline' | 'socket', started?: () => void, stay = false) {
  const room = new Room({ version: pkg.version });
  const find = finder();
  const inline = mode === 'inline' ? { harnesses: await find(), find, projectDir: process.env.INIT_CWD ?? process.cwd() } : { bench: room.bench, runner: room };
  // The keyholder's own home is the role account's, so the clones go where the runner's owner keeps theirs.
  let owner = os.homedir();
  const plugin = new Plugin({
    code,
    dataDir,
    get cloneRoot() {
      owner = room.runner?.hello.home || owner;
      return path.join(owner, 'WebChat');
    },
    wake: `run ${cli} wake in a terminal on your laptop`,
    ...inline,
  });
  await room.listen(file, plugin);
  started?.();
  // Exiting runs the exit handlers, which free the machine's watch.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
  // A sleeping plugin waits on unref'd timers, and nothing else would keep this process.
  const alive = setInterval(() => {}, 2 ** 30);
  await plugin.serve();
  // A service that is not paired stays up to say so over the socket, and not restart in a loop.
  if (stay) return void console.error(plugin.problem);
  clearInterval(alive);
  throw new Error(plugin.problem);
}

/** What a command says to the keyholder, and the text it answers with. */
async function tell(method: string, params: object = {}) {
  console.log((await callRoom(socketFile(), method, params, pkg.version)).text);
}

/** Pairs as the role account, which is the only way the keyholder gets an account (docs/decisions/locked-room.md). */
async function pairAsRole() {
  if (!os.userInfo().username.startsWith('_webchat')) throw new Error('This pairs the agent’s own account, and runs as its role account only: `webchat-agent setup` does that.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const { code, picks } = JSON.parse(Buffer.concat(chunks).toString()) as { code: string; picks?: PairingPick[] };
  return pairInto(path.join(dataDir, 'account.json'), code, picks);
}

async function main([command, ...args]: string[]) {
  switch (command) {
    case 'pair': {
      const [pasted, name] = args;
      // Setup's sudo runs this as the role account, with the code and picks on stdin so no process list shows the code.
      if (!pasted && !name) return pairAsRole();
      if (!pasted || !name) throw new Error('usage: pair <code> <name>');
      if (await fs.stat(fileFor(name)).then(() => true, () => false)) throw new Error(`${fileFor(name)} holds an agent already. Pick another name.`);
      return pairInto(fileFor(name), pasted);
    }
    case 'setup':
      return setup(args[0], { home, program: isSea() ? process.execPath : '' });
    case 'doctor':
      return doctor(home);
    case 'status':
      await status(home);
      // What the running keyholder says, when it runs.
      return callRoom<{ text: string; runner: boolean }>(socketFile(), 'status', {}, pkg.version).then(({ text, runner }) => console.log(`Runner: ${runner ? 'connected' : 'not connected'}\n${text}`), () => undefined);
    case 'uninstall':
      return uninstall(home);
    case 'serve':
      return keyholder(args[0] ?? '', process.env.WEBCHAT_SOCKET ?? legacySocket, 'inline');
    case 'keyholder':
      return keyholder(args[0] ?? '', socketFile(), 'socket', undefined, true);
    case 'runner':
      return runner(socketFile());
    case 'dev': {
      // Both halves in this process, over a socket in a folder of its own: for working on WebChat, never shipped.
      if (isSea()) throw new Error('dev is for working on WebChat. Run keyholder and runner, which setup installs.');
      const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-dev-')), 'keyholder.sock');
      return keyholder(args[0] ?? '', file, 'socket', () => void runner(file));
    }
    case 'connect': {
      const dir = process.env.INIT_CWD ?? process.cwd();
      const { repo } = await new LocalBench([]).checkout(dir);
      if (!repo) throw new Error(NO_REPOSITORY);
      return tell('request', { kind: 'connect', repo, dir });
    }
    case 'sleep':
    case 'wake':
      return tell(command);
    case 'link': {
      const harness = supported(args[0] ?? '');
      if (!harness) throw new Error(`${args[0] ? `'${args[0]}' is not a harness WebChat supports` : 'Name the harness to link'}. Supported: ${supportedList()}.`);
      return tell('request', { kind: 'link', harness: harness.name });
    }
    case 'guard':
      return runGuard(args[0] ?? '');
    // The submit_answer MCP server an ACP agent starts for each session (agent/answer.ts).
    case 'answer':
      return runAnswerServer();
    case '--version':
      return console.log(pkg.version);
    case 'watch':
      throw new Error('Cards run from the Coding agents pane, which `serve` answers in its sandbox (D-105). See the README.');
    default:
      throw new Error(`usage: ${cli} setup|doctor|status|uninstall|serve|keyholder|runner|dev|connect|sleep|wake|link|pair ...`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
