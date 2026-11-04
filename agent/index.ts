// The agent daemon's command line (R-027): an account that signs up, signs in, and watches its chats
// for cards that the teammates it allows hand to it. Until an adapter runs a coding agent (step 3
// of the item), every request is reported as failed.
//
//   npm run agent -- signup <server> <username> <invite-code>
//   npm run agent -- login <server> <username>
//   npm run agent -- allow <username> <teammate>
//   npm run agent -- watch <username>
//
// The password comes from WEBCHAT_PASSWORD, or is asked for. Accounts live under WEBCHAT_AGENT_HOME,
// by default ~/.webchat, one folder per username.
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { AgentClient, type OpenedMessage } from './client.ts';
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

async function main([command, ...args]: string[]) {
  switch (command) {
    case 'signup': {
      const [server, username, inviteCode] = args;
      if (!server || !username || !inviteCode) throw new Error('usage: signup <server> <username> <invite-code>');
      const client = await AgentClient.signUp(fileFor(username), { server, username, password: await password() }, username, inviteCode);
      console.log(`Signed up as ${username} (#${client.id}). Keys are in ${fileFor(username)}.`);
      return;
    }
    case 'login': {
      const [server, username] = args;
      if (!server || !username) throw new Error('usage: login <server> <username>');
      const client = await AgentClient.signIn(fileFor(username), { server, username, password: await password() });
      console.log(`Signed in as ${username} (#${client.id}). Keys are in ${fileFor(username)}.`);
      return;
    }
    case 'allow': {
      const [username, teammate] = args;
      if (!username || !teammate) throw new Error('usage: allow <username> <teammate>');
      await (await AgentClient.load(fileFor(username))).allow(teammate);
      console.log(`${teammate} can now hand cards to ${username}.`);
      return;
    }
    case 'watch': {
      const [username] = args;
      if (!username) throw new Error('usage: watch <username>');
      const client = await AgentClient.load(fileFor(username));
      const runs = new Runs(client, async () => {
        throw new Error('This runtime has no coding agent yet.');
      });
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
        console.log(`${project.name}: ${channels.join(', ')}`);
      }
      missed.forEach(print);
      for await (const message of client.watch(stop.signal)) print(message);
      return;
    }
    default:
      throw new Error('usage: npm run agent -- signup|login|allow|watch ...');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
