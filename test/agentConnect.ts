import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { test } from 'node:test';
import { claudeHarness } from '../agent/claude.ts';
import { AgentClient } from '../agent/client.ts';
import { Plugin } from '../agent/plugin.ts';
import { Room } from '../agent/room.ts';
import { REQUEST_TTL_MS } from '../agent/runs.ts';
import { newPairingCode, type MessageContent } from '../shared/e2ee.ts';
import { type AskDTO, type CreateProjectResponse } from '../shared/types.ts';
import { sh, git, connect, newChatKey, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function connectTests(w: World) {
  test('connects a folder only on its owner\'s signed approval, within 10 minutes and once (docs/decisions/connect-approval.md)', { timeout: 60_000 }, async () => {
    const dataDir = path.join(w.home, 'connector', 'laptop');
    const folder = path.join(w.home, 'connector-app');
    await sh('git', ['init', '-q', folder]);
    const setOrigin = (repo: string) => git(folder, 'remote', 'set-url', 'origin', `https://github.com/${repo}.git`);
    await git(folder, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    const options = { harnesses: [claudeHarness('', dataDir)], cloneRoot: path.join(w.home, 'WebChat'), dataDir, code: '' };
    const terminal = new Plugin(options);
    assert.match(await new Plugin({ ...options, dataDir: path.join(w.home, 'unpaired') }).requestConnect(folder, 'acme/app'), /Pair first/);
    const code = newPairingCode();
    const plugin = new Plugin({ ...options, code: `${w.baseUrl}#${code}` });
    const starting = plugin.start();
    const agent = await approve(w.alice, code, 'Connector');
    assert.equal(await starting, true);
    await w.alice.sync();
    await w.carol.sync();
    const carols = (await w.carol.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(w.carol, [w.carol.id, agent.id]) })).id;
    const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).id;
    const group = (await w.alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Connect', memberIds: [agent.id], key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).channel.id;
    await w.alice.sync();
    await w.carol.sync();
    await plugin.client!.sync();
    const mark = path.join(dataDir, 'repos', 'acme__app', 'connected');
    const pending = () => (plugin as unknown as { setup: { asks?: Record<string, { at: number }> } }).setup.asks ?? {};
    const heard = async () => {
      const messages = await plugin.client!.sync();
      await Promise.all(messages.map((m) => plugin.handle(m)));
      return messages;
    };
    const failures: string[] = [];
    const said = async () => {
      const asks = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.ask).map((m) => m.content!);
      failures.push(...asks.filter((c) => c.ask?.step === 'failed').map((c) => c.text));
      return asks.filter((c) => c.ask?.step !== 'failed');
    };
    // What a person types in the folder, then the serving agent's tick: the request Alice sees, and its client id.
    const ask = async () => {
      assert.match(await terminal.requestConnect(folder, 'acme/app'), /Asked your agent's owner to connect acme\/app/);
      await plugin.sendAsks();
      const [sent] = await said();
      assert.equal(sent?.ask?.step, 'request');
      return { request: sent!.ask as Extract<AskDTO, { kind: 'connect'; step: 'request' }>, to: Object.keys(pending()).at(-1)! };
    };
    type Asked = Awaited<ReturnType<typeof ask>>;
    const answer = async (from: AgentClient, chat: number, step: 'approve' | 'decline', asked: Asked, extra: object = {}) => {
      const { repo, folder: shown } = asked.request;
      await from.send(chat, { text: 'Answer', ask: { kind: 'connect', step, to: asked.to, sentAt: Date.now(), ...(step === 'approve' && { repo, folder: shown }), ...extra } as MessageContent['ask'] });
      return heard();
    };
    const nothing = async (why: string) => {
      await plugin.scan();
      assert.equal(existsSync(mark), false, why);
      assert.deepEqual(plugin.client!.repos, [], why);
    };

    // The real command, typed in a terminal, files a request and returns: nothing changes.
    // It asks the keyholder over its socket, which here is the terminal's plugin.
    const room = new Room({ version: pkg.version });
    await room.listen(path.join(w.home, 'connector', 'keyholder.sock'), terminal);
    const run = await sh(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../agent/index.ts', import.meta.url)), 'connect'], {
      cwd: folder,
      env: { PATH: '/usr/bin:/bin', HOME: path.join(w.home, 'connector'), WEBCHAT_AGENT_HOME: path.join(w.home, 'connector'), WEBCHAT_SOCKET: path.join(w.home, 'connector', 'keyholder.sock') },
    }).finally(() => room.close());
    assert.match(run.stdout, /Asked your agent's owner to connect acme\/app/);
    await nothing('a typed connect marks nothing');
    await plugin.sendAsks();
    const [first] = await said();
    assert.deepEqual([first?.ask?.step, (first?.ask as { repo?: string })?.repo], ['request', 'acme/app']);
    await nothing('a request marks nothing');
    // A second command for the repository while one waits sends no second request.
    await terminal.requestConnect(folder, 'acme/app');
    await plugin.sendAsks();
    assert.deepEqual(await said(), []);
    // Not the owner's word: Carol's in her own chat with the agent, Alice's outside her direct chat, a request nobody made, and one signed too long ago.
    const open: Asked = { request: first!.ask as Asked['request'], to: Object.keys(pending())[0]! };
    await answer(w.carol, carols, 'approve', open);
    await answer(w.alice, group, 'approve', open);
    await answer(w.alice, direct, 'approve', { ...open, to: 'nobody' });
    await answer(w.alice, direct, 'approve', open, { sentAt: Date.now() - REQUEST_TTL_MS - 1000 });
    await nothing('only the owner, in the direct chat, lately, and for a request that was made');
    // Her approve connects the folder the laptop recorded, once.
    const approving = await answer(w.alice, direct, 'approve', open);
    assert.equal(await fs.readFile(mark, 'utf8'), await fs.realpath(folder), 'the folder the command ran in');
    assert.deepEqual(plugin.client!.repos, ['acme/app']);
    assert.equal((await said()).at(-1)?.ask?.step, 'done');
    // The same message again, or another that names the same request, connects nothing once it is disconnected.
    await fs.rm(mark);
    await plugin.handle(approving.find((m) => m.content?.ask)!);
    await answer(w.alice, direct, 'approve', open);
    await nothing('an approval counts once');

    // A request left past 10 minutes by the agent's clock fails with a note.
    const lapsed = await ask();
    pending()[lapsed.to]!.at -= REQUEST_TTL_MS + 1000;
    await answer(w.alice, direct, 'approve', lapsed);
    await nothing('a lapsed request');
    await said();
    assert.match(failures.at(-1)!, /older than 10 minutes/);
    // An approval for another folder or repository than the request showed, and a folder that moved to another repository, connect nothing.
    const another = await ask();
    await answer(w.alice, direct, 'approve', another, { folder: `${another.request.folder}-other` });
    await nothing('another folder');
    const elsewhere = await ask();
    await answer(w.alice, direct, 'approve', elsewhere, { repo: 'acme/other' });
    await nothing('another repository');
    const moved = await ask();
    await setOrigin('acme/other');
    await answer(w.alice, direct, 'approve', moved);
    await setOrigin('acme/app');
    await nothing('a folder that pushes elsewhere now');
    // A decline connects nothing, and the request cannot be approved after it.
    const declined = await ask();
    await answer(w.alice, direct, 'decline', declined);
    await answer(w.alice, direct, 'approve', declined);
    await nothing('a decline');
    await said();
    assert.equal(failures.length, 4, 'each refusal is said, and a decline or an approval of nothing is not');
    // A folder connected already asks nothing.
    await connect(dataDir, 'acme/app', folder);
    assert.match(await terminal.requestConnect(folder, 'acme/app'), /connected to this folder already/);
  });
}
