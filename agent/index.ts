// The agent daemon's command line (R-027): an account that signs up, signs in, and watches its chats
// for cards that its owner hands to it, which it runs with the coding agent on this machine (D-089).
// `config.json` next to the account file names each project's repository (D-087).
//
//   npm run agent -- signup <server> <username> <invite-code> <owner>
//   npm run agent -- login <server> <username> <owner>
//   npm run agent -- watch <username>
//
// The password comes from WEBCHAT_PASSWORD, or is asked for. Accounts live under WEBCHAT_AGENT_HOME,
// by default ~/.webchat, one folder per username.
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { safetyCode } from '../shared/e2ee.ts';
import { AgentClient, type OpenedMessage } from './client.ts';
import { createRunner, loadRunnerConfig } from './runner.ts';
import { Runs } from './runs.ts';

const home = process.env.WEBCHAT_AGENT_HOME ?? path.join(os.homedir(), '.webchat');
const fileFor = (username: string) => path.join(home, username, 'account.json');

async function password() {
  if (process.env.WEBCHAT_PASSWORD) return process.env.WEBCHAT_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question('Password: ');
  } finally {
    rl.close();
  }
}

/**
 * Pins the owner's keys with a first check-in, and prints the security code they compare in a
 * direct chat with the agent (D-018), since the server named them and could have swapped keys.
 */
async function welcome(client: AgentClient, done: string) {
  await client.sync();
  const owner = client.users.get(client.owner!)!;
  console.log(`${done} (#${client.id}), the agent of ${owner.displayName}.`);
  const keys = client.keysOf(owner.id);
  if (!keys) return console.log(`${owner.displayName} has no keys yet: they sign in once in a browser, then you sign in here again.`);
  const code = await safetyCode({ id: client.id, keys: client.identity.publicKeys }, { id: owner.id, keys });
  console.log(`${owner.displayName}: open a direct chat with this agent in WebChat, and check that its security code is`);
  console.log(code.join(' '));
}

async function main([command, ...args]: string[]) {
  switch (command) {
    case 'signup': {
      const [server, username, inviteCode, owner] = args;
      if (!server || !username || !inviteCode || !owner) throw new Error('usage: signup <server> <username> <invite-code> <owner>');
      const client = await AgentClient.signUp(fileFor(username), { server, username, password: await password() }, username, inviteCode, owner);
      return welcome(client, `Signed up as ${username}`);
    }
    case 'login': {
      const [server, username, owner] = args;
      if (!server || !username || !owner) throw new Error('usage: login <server> <username> <owner>');
      const client = await AgentClient.signIn(fileFor(username), { server, username, password: await password() }, owner);
      return welcome(client, `Signed in as ${username}`);
    }
    case 'watch': {
      const [username] = args;
      if (!username) throw new Error('usage: watch <username>');
      const client = await AgentClient.load(fileFor(username));
      if (!client.owner) throw new Error(`Name whose cards ${username} runs: npm run agent -- login <server> ${username} <owner>`);
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
      throw new Error('usage: npm run agent -- signup|login|watch ...');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
