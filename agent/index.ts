// The agent daemon's command line (R-027): the host for a laptop without Claude Code, which serves the
// same Plugin as agent/mcp.ts, in the folder `laptop` of the agent home. Keep `serve` running, in a terminal
// or as a launchd or systemd service. `connect`, `sleep` and `wake` do what the /webchat: skills do, and
// `connect` marks the folder you run it in. `pair` makes an account of its own, which `serve` does not use
// unless its name is `laptop`.
//
//   npm run agent -- serve [code]
//   npm run agent -- connect|sleep|wake
//   npm run agent -- pair <code> <name>
//
// The code comes from Connect coding agent in WebChat (R-030). Accounts live under
// WEBCHAT_AGENT_HOME, by default ~/.webchat, one folder per name.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudePlugin, claudeProgram } from './claude.ts';
import { AgentClient, readPairing } from './client.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const fileFor = (name: string) => path.join(home, name, 'account.json');

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
    // mcp.ts runs the hook, and the daemon has no bundle, so its TypeScript goes through tsx.
    guard: `"${process.execPath}" --import "${import.meta.resolve('tsx')}" "${fileURLToPath(new URL('./mcp.ts', import.meta.url))}" guard "${dataDir}"`,
  });
}

async function main([command, ...args]: string[]) {
  switch (command) {
    case 'pair': {
      const [pasted, name] = args;
      if (!pasted || !name) throw new Error('usage: pair <code> <name>');
      const { server, code } = readPairing(pasted, '');
      if (await fs.stat(fileFor(name)).then(() => true, () => false)) throw new Error(`${fileFor(name)} holds an agent already. Pick another name.`);
      console.log('Approve the agent in WebChat, in the window that shows the code.');
      const client = await AgentClient.pair(fileFor(name), server, code);
      await client.sync();
      console.log(`Paired with ${client.users.get(client.owner!)?.displayName}.`);
      return;
    }
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
      const said = await (await laptop()).call(command);
      console.log(said.replace('/webchat:wake', 'npm run agent -- wake'));
      return;
    }
    case 'watch':
      throw new Error('Cards run from the Coding agents pane, which `serve` answers in its sandbox (D-105). See the README.');
    default:
      throw new Error('usage: npm run agent -- serve|connect|sleep|wake|pair ...');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
