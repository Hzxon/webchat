// The agent daemon's command line (R-027): an account that pairs with its owner. It no longer takes
// cards: they run from the Coding agents pane, which only the plugin answers, in its sandbox (D-105).
//
//   npm run agent -- pair <code> <name>
//
// The code comes from Connect coding agent in WebChat (R-030). Accounts live under
// WEBCHAT_AGENT_HOME, by default ~/.webchat, one folder per name.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentClient, readPairing } from './client.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const fileFor = (name: string) => path.join(home, name, 'account.json');

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
    case 'watch':
      // Cards run from the Coding agents pane, which only the plugin answers, in its sandbox (D-105).
      throw new Error('The daemon no longer takes cards. Cards run through the WebChat plugin in Claude Code: see the README.');
    default:
      throw new Error('usage: npm run agent -- pair|watch ...');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
