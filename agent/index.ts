// The agent daemon's command line (R-027): an account that pairs with its owner and watches its
// chats for cards that its owner hands to it, which it runs with the coding agent on this machine
// (D-089). `config.json` next to the account file names each project's repository (D-087).
//
//   npm run agent -- pair <code> <name>
//   npm run agent -- watch <name>
//
// The code comes from Connect coding agent in WebChat (R-030). Accounts live under
// WEBCHAT_AGENT_HOME, by default ~/.webchat, one folder per name.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentClient, readPairing, type OpenedMessage } from './client.ts';
import { createRunner, loadRunnerConfig } from './runner.ts';
import { Runs } from './runs.ts';

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
      console.log(`Paired with ${client.users.get(client.owner!)?.displayName}. Start it with: npm run agent -- watch ${name}`);
      return;
    }
    case 'watch': {
      const [username] = args;
      if (!username) throw new Error('usage: watch <name>');
      const client = await AgentClient.load(fileFor(username));
      if (!client.owner) throw new Error(`Pair ${username} with its owner first: npm run agent -- pair <code> ${username}`);
      const dir = path.dirname(fileFor(username));
      const config = await loadRunnerConfig(dir);
      const runs = new Runs(client, createRunner(config, client, path.join(dir, 'runs')));
      const stop = new AbortController();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
      const print = (message: OpenedMessage) => {
        const chat = client.conversations.get(message.conversationId);
        const where = chat?.title ? `#${chat.title}` : 'direct';
        const who = (message.senderId && client.users.get(message.senderId)?.displayName) || 'GitHub';
        console.log(`[${where}] ${who}: ${message.content?.text ?? `(${message.security})`}`);
        // A run takes long, and check-ins go on meanwhile. Its reports carry its errors.
        runs.handle(message).catch((error: unknown) => console.error(String(error)));
      };
      const missed = await client.sync();
      // A run cut short when the daemon last stopped would show as claimed for good (K-46).
      await runs.recover().catch((error: unknown) => console.error(String(error)));
      for (const project of client.projects) {
        const channels = [...client.conversations.values()].filter((c) => c.projectId === project.id).map((c) => `#${c.title}`);
        const repo = config.projects[project.name] ?? `none, so its cards fail until ${path.join(dir, 'config.json')} names one`;
        console.log(`${project.name}: ${channels.join(', ')}. Repository: ${repo}`);
      }
      missed.forEach(print);
      for await (const message of client.watch(stop.signal)) print(message);
      return;
    }
    default:
      throw new Error('usage: npm run agent -- pair|watch ...');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
