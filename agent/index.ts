// The agent daemon's command line (R-027): the host for a laptop without Claude Code, which serves the
// same Plugin as agent/mcp.ts, in the folder `laptop` of the agent home. `setup` installs a login
// service that keeps `serve` running (agent/setup.ts), and `doctor`, `status` and `uninstall` go with it.
// `connect`, `sleep` and `wake` do what the /webchat: skills do, and `connect` marks the folder you run
// it in. `pair` makes an account of its own, which `serve` does not use unless its name is `laptop`.
//
//   npm run agent -- serve [code]
//   npm run agent -- connect|sleep|wake
//   npm run agent -- pair <code> <name>
//
// Each release also ships it as one file per OS, webchat-agent, with Node inside (agent/sea.json),
// which takes the same commands, `setup [code]`, `doctor`, `status`, `uninstall` and `--version`.
//
// The code comes from Connect coding agent in WebChat (R-030). Accounts live under
// WEBCHAT_AGENT_HOME, by default ~/.webchat, one folder per name.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { ClaudePlugin, claudeProgram, runGuard } from './claude.ts';
import { doctor, pairInto, setup, status, uninstall } from './setup.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const fileFor = (name: string) => path.join(home, name, 'account.json');
const cli = isSea() ? 'webchat-agent' : 'npm run agent --';
// The guard hook runs this program again: the single file, or this script through tsx.
const self = isSea() ? `"${process.execPath}"` : `"${process.execPath}" --import "${import.meta.resolve('tsx')}" "${fileURLToPath(import.meta.url)}"`;

/** The Plugin as this daemon hosts it, with the Claude adapter, in the folder only it uses (D-085). */
async function laptop(code = '') {
  const dataDir = path.join(home, 'laptop');
  return new ClaudePlugin({
    code,
    dataDir,
    // npm runs the script in its own folder and leaves the folder you typed it in as INIT_CWD.
    projectDir: process.env.INIT_CWD ?? process.cwd(),
    cloneRoot: path.join(os.homedir(), 'WebChat'),
    claude: await claudeProgram(),
    wake: `run ${cli} wake in a terminal on your laptop`,
    guard: `${self} guard "${dataDir}"`,
  });
}

async function main([command, ...args]: string[]) {
  switch (command) {
    case 'pair': {
      const [pasted, name] = args;
      if (!pasted || !name) throw new Error('usage: pair <code> <name>');
      if (await fs.stat(fileFor(name)).then(() => true, () => false)) throw new Error(`${fileFor(name)} holds an agent already. Pick another name.`);
      return pairInto(fileFor(name), pasted);
    }
    case 'setup':
      return setup(args[0], { home, program: isSea() ? process.execPath : '' });
    case 'doctor':
      return doctor(home);
    case 'status':
      return status(home);
    case 'uninstall':
      return uninstall(home);
    case 'serve': {
      const plugin = await laptop(args[0]);
      // Exiting runs the exit handlers, which free the machine's watch.
      for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
      // A sleeping plugin waits on unref'd timers. Claude Code's open stdin keeps the MCP server alive, and nothing else would keep this one.
      const alive = setInterval(() => {}, 2 ** 30);
      await plugin.serve();
      clearInterval(alive);
      throw new Error(plugin.problem);
    }
    case 'connect':
    case 'sleep':
    case 'wake': {
      console.log(await (await laptop()).call(command));
      return;
    }
    case 'guard':
      return runGuard(args[0] ?? '');
    case '--version':
      return console.log(pkg.version);
    case 'watch':
      throw new Error('Cards run from the Coding agents pane, which `serve` answers in its sandbox (D-105). See the README.');
    default:
      throw new Error(`usage: ${cli} setup|doctor|status|uninstall|serve|connect|sleep|wake|pair ...`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
