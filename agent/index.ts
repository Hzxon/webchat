// The agent's command line (R-027, docs/decisions/locked-room.md). `setup` builds the room: a role
// account that holds the agent's keys, a root-owned program, and two services that run this program,
// `keyholder` as the role account and `runner` as the owner, which work in the owner's folders for
// it (agent/room.ts). `doctor`, `status` and `uninstall` go with it. `connect`, `link`, `sleep` and
// `wake` ask the keyholder over its socket, and `connect` and `link` are requests the owner
// approves in WebChat. `dev` runs both halves in one process, over a socket of its own, for working
// on WebChat. `pair` is setup's, run by sudo as the role account with the code on stdin.
//
//   npm run agent -- dev [code]
//   npm run agent -- keyholder|runner
//   npm run agent -- connect|sleep|wake
//   npm run agent -- link claude|codex
//
// Each release also ships it as one file per OS, webchat-agent, with Node inside (agent/sea.json),
// which takes the same commands, `setup [code]`, `doctor`, `status`, `uninstall` and `--version`.
//
// The code comes from Connect coding agent in WebChat (R-030). The agent's account lives in the role
// account's folder, and the runner's files in WEBCHAT_AGENT_HOME, by default ~/.webchat.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import pkg from '../package.json' with { type: 'json' };
import type { PairingPick } from '../shared/types.ts';
import { runAnswerServer } from './answer.ts';
import { onPath, pathDirs } from './claude.ts';
import { harnessFinder, supported, supportedList } from './harnesses.ts';
import { LocalBench } from './bench.ts';
import { layoutFor, selfProblem, socketOf } from './lockroom.ts';
import { NO_REPOSITORY, Plugin } from './plugin.ts';
import { callRoom, Room, runRunner, type RoomStatus } from './room.ts';
import { doctor, pairInto, setup, status, uninstall } from './setup.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const cli = isSea() ? 'webchat-agent' : 'npm run agent --';
/** Where the commands find the keyholder: the folder setup makes (docs/decisions/locked-room.md). */
const socketFile = () => process.env.WEBCHAT_SOCKET ?? socketOf(layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux'));
const dataDir = path.join(home, 'laptop');

/** What works in the owner's folders, for the runner: the harnesses and the owner's setup (D-085). */
async function runner(file: string) {
  // The runner's own files, apart from the keyholder's `laptop` that a laptop from before the room still has.
  const runnerDir = path.join(home, 'runner');
  const find = harnessFinder({ dataDir: runnerDir });
  return runRunner({ file, bench: new LocalBench(await find(), find, runnerDir), version: pkg.version, say: console.error });
}

/**
 * The keyholder: the Plugin, serving the commands on a socket and asking a runner for all that
 * happens in the owner's folders. As a `service` it first checks itself, and a service that is not
 * paired stays up to say so over the socket, and does not restart in a loop.
 */
async function keyholder(code: string, file: string, started?: () => void, service = false) {
  process.umask(0o077);
  if (service) {
    const problem = await selfProblem({ user: os.userInfo().username, uid: process.getuid!(), data: home, programs: [process.execPath, await onPath('git', pathDirs()), await onPath('gh', pathDirs())] });
    if (problem) throw new Error(`The keyholder does not start: ${problem}`);
  }
  const room = new Room({ version: pkg.version });
  // The keyholder's own home is the role account's, so the clones go where the runner's owner keeps theirs.
  let owner = os.homedir();
  const plugin = new Plugin({
    code,
    dataDir,
    get cloneRoot() {
      owner = room.runner?.hello.home || owner;
      return path.join(owner, 'WebChat');
    },
    bench: room.bench,
    runner: room,
  });
  await room.listen(file, plugin);
  started?.();
  // Exiting runs the exit handlers, which free the machine's watch.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
  // A sleeping plugin waits on unref'd timers, and nothing else would keep this process.
  const alive = setInterval(() => {}, 2 ** 30);
  await plugin.serve();
  if (service) return void console.error(plugin.problem);
  clearInterval(alive);
  throw new Error(plugin.problem);
}

/** What a command says to the keyholder, and the text it answers with. */
async function tell(method: string, params: object = {}) {
  console.log((await callRoom<{ text: string }>(socketFile(), method, params, pkg.version)).text);
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
    // Setup's sudo runs this as the role account, with the code and picks on stdin so no process list shows the code.
    case 'pair':
      return pairAsRole();
    case 'setup':
      return setup(args[0], { home, program: isSea() ? process.execPath : '' });
    case 'doctor':
      return doctor(home);
    case 'status':
      await status(home);
      // What the running keyholder says, when it runs.
      return callRoom<RoomStatus>(socketFile(), 'status', {}, pkg.version).then(({ text, runner, paired }) => console.log(`Runner: ${runner ? 'connected' : 'not connected'}\nPaired: ${paired ? 'yes' : 'no'}\n${text}`), () => undefined);
    case 'uninstall':
      return uninstall(home);
    // The login service of a laptop from before the room still runs this: it says so and idles, rather than restart in a loop.
    case 'serve':
      console.error('This command is retired: run `webchat-agent setup`, which replaces this service.');
      return void setInterval(() => {}, 2 ** 30);
    case 'keyholder':
      return keyholder('', socketFile(), undefined, true);
    case 'runner':
      return runner(socketFile());
    case 'dev': {
      // Both halves in this process, over a socket in a folder of its own: for working on WebChat, never shipped.
      if (isSea()) throw new Error('dev is for working on WebChat. Run keyholder and runner, which setup installs.');
      const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-dev-')), 'keyholder.sock');
      return keyholder(args[0] ?? '', file, () => void runner(file));
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
    // The submit_answer MCP server an ACP agent starts for each session (agent/answer.ts).
    case 'answer':
      return runAnswerServer();
    case '--version':
      return console.log(pkg.version);
    default:
      throw new Error(`usage: ${cli} setup|doctor|status|uninstall|keyholder|runner|dev|connect|sleep|wake|link ...`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
