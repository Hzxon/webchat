import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentClient, type OpenedMessage } from '../agent/client.ts';
import type { Harness, Reply } from '../agent/harness.ts';
import { Conversations, type Answerer } from '../agent/conversations.ts';
import { Plugin } from '../agent/plugin.ts';
import { newPairingCode, permitHash } from '../shared/e2ee.ts';
import { type CreateProjectResponse, type PermitDTO, type PromptDTO } from '../shared/types.ts';
import { KDF_ROUNDS, PASSWORD, newChatKey, waitFor, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function promptTests(w: World) {
  test('answers its owner\'s prompts in their direct chat, and resumes the conversation for each reply (R-035)', async () => {
    // A fresh owner, since Alice's sends in the tests before count against the rate limit.
    const owner = await AgentClient.signUp(path.join(w.home, 'erin.json'), { server: w.baseUrl, username: 'erin', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Erin', 'friends-only');
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(w.home, 'talker.json'), w.baseUrl, code, 10);
    await approve(owner, code, 'Talker');
    const agent = await pairing;
    await owner.sync();
    await w.carol.sync();
    const open = async (person: AgentClient) =>
      (await person.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(person, [person.id, agent.id]) })).id;
    const direct = await open(owner);
    const carols = await open(w.carol);
    const group = (await owner.request<CreateProjectResponse>('POST', '/projects', { name: 'Talk', memberIds: [agent.id], key: await newChatKey(owner, [owner.id, agent.id]) })).channel.id;
    await owner.sync();
    await w.carol.sync();
    await agent.sync();

    const calls: { input: string; resume: boolean; session: string }[] = [];
    // What the next call does; it gets the call's signal.
    let next: (signal: AbortSignal) => Promise<string> | string = () => 'It adds.';
    const answer: Answerer = ({ conversation, input, resume, signal }) => {
      calls.push({ input, resume, session: conversation.session });
      return Promise.resolve(next(signal)).then((reply) => ({ reply }));
    };
    const conversations = new Conversations(agent, path.join(w.home, 'talker-conversations.json'), answer);
    const asks = (extra: Partial<Extract<PromptDTO, { kind: 'prompt' }>> = {}): PromptDTO => ({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), ...extra });
    const hear = async () => {
      const heard = await agent.sync();
      for (const m of heard) await conversations.handle(m);
      return heard;
    };
    const said = async () => (await owner.sync()).filter((m) => m.senderId === agent.id).map((m) => [m.content?.prompt, m.content?.text]);

    const first = (await owner.send(direct, { text: 'What does sum.js do?', prompt: asks() })).clientId!;
    await hear();
    assert.deepEqual(calls, [{ input: 'What does sum.js do?', resume: false, session: calls[0]!.session }]);
    assert.deepEqual(await said(), [[{ kind: 'answer', to: first }, 'It adds.']]);

    await owner.send(direct, { text: 'And the test?', prompt: { kind: 'reply', to: first, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls[1], { input: 'And the test?', resume: true, session: calls[0]!.session });
    await said();

    // None of these starts a conversation: nothing runs, and nothing is said.
    await w.carol.send(carols, { text: 'Hi', prompt: asks() });
    await owner.send(group, { text: 'In a channel', prompt: asks() });
    const signed = await owner.send(direct, { text: 'Once', prompt: asks() });
    const heard = await agent.sync();
    for (const m of heard) if (m.id !== signed.id) await conversations.handle(m);
    assert.equal(calls.length, 2, 'no turn ran for them');
    assert.deepEqual(await said(), []);
    const once = heard.find((m) => m.id === signed.id)!;
    await conversations.handle(once);
    assert.equal(calls.length, 3, 'the real one runs');
    assert.equal((await said()).length, 1);
    // The same signed message under a new id, as a server could post it again, runs nothing (K-47).
    await conversations.handle({ ...once, id: once.id + 1000 });
    assert.equal(calls.length, 3);
    // One laptop answers every conversation, so a reply it cannot place hears so (R-036).
    await owner.send(direct, { text: 'Remember me?', prompt: { kind: 'reply', to: 'gone', sentAt: Date.now() } });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: 'gone' }, 'I no longer know this conversation. Start a new one.']]);
    assert.deepEqual(await said(), []);

    // A prompt signed 11 minutes ago is refused, and a reply asks it again, afresh.
    const skipped = (await owner.send(direct, { text: 'Old', prompt: asks({ sentAt: Date.now() - 11 * 60_000 }) })).clientId!;
    await hear();
    assert.equal(calls.length, 3);
    assert.deepEqual((await said()).map((m) => m[1]), ['I got this more than 10 minutes after you sent it, so I skipped it. Reply to ask again.']);
    await owner.send(direct, { text: 'Now?', prompt: { kind: 'reply', to: skipped, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls.slice(3).map((c) => [c.input, c.resume]), [['Old\n\nNow?', false]]);
    assert.deepEqual((await said()).map((m) => m[1]), ['It adds.']);
    calls.length = 3;

    // A long answer comes as several messages, in order, each within the limit.
    const long = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(1000)).join('\n');
    next = () => long;
    await owner.send(direct, { text: 'Tell me everything', prompt: asks() });
    await hear();
    const pieces = (await said()).map((m) => m[1] as string);
    assert.ok(pieces.length > 1 && pieces.every((text) => text.length <= 4000), 'each message is short enough');
    assert.equal(pieces.join(''), long, 'in order, with nothing lost');

    // A cancel stops the turn that waits.
    next = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted.'))));
    const slow = await owner.send(direct, { text: 'Think hard', prompt: asks() });
    const waiting = hear();
    for (let tries = 0; tries < 500 && calls.length < 5; tries++) await sleep(10);
    assert.equal(calls.length, 5, 'the turn started');
    await owner.send(direct, { text: 'Stop', prompt: { kind: 'cancel', to: slow.clientId!, sentAt: Date.now() } });
    await hear();
    await waiting;
    assert.deepEqual(await said(), [[{ kind: 'failed', to: slow.clientId! }, 'I stopped, as you asked.']]);

    // A turn that throws says why.
    next = () => {
      throw new Error('No luck.');
    };
    const broken = await owner.send(direct, { text: 'Try', prompt: asks() });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: broken.clientId! }, 'I could not answer. No luck.']]);

    // A first turn that throws, then a reply: it starts afresh with the prompt and the reply.
    next = () => {
      throw new Error('No luck.');
    };
    const retried = await owner.send(direct, { text: 'Try again', prompt: asks() });
    await hear();
    await said();
    next = () => 'Now it works.';
    await owner.send(direct, { text: 'Please?', prompt: { kind: 'reply', to: retried.clientId!, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(calls.at(-1)!.resume, false);
    assert.equal(calls.at(-1)!.input, 'Try again\n\nPlease?');
    assert.deepEqual(await said(), [[{ kind: 'answer', to: retried.clientId! }, 'Now it works.']]);

    // A prompt and its reply from one check-in give two turns, in order.
    next = () => 'One.';
    const together = await owner.send(direct, { text: 'First?', prompt: asks() });
    await owner.send(direct, { text: 'Second?', prompt: { kind: 'reply', to: together.clientId!, sentAt: Date.now() } });
    const pair = await agent.sync();
    const started = calls.length;
    await Promise.all(pair.map((m) => conversations.handle(m)));
    assert.deepEqual(calls.slice(started).map((c) => [c.input, c.resume]), [['First?', false], ['Second?', true]]);
    await said();

    // A prompt and its cancel from one check-in stop the turn.
    next = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted.'))));
    const doomed = await owner.send(direct, { text: 'Think hard again', prompt: asks() });
    await owner.send(direct, { text: 'Stop', prompt: { kind: 'cancel', to: doomed.clientId!, sentAt: Date.now() } });
    await Promise.all((await agent.sync()).map((m) => conversations.handle(m)));
    assert.deepEqual(await said(), [[{ kind: 'failed', to: doomed.clientId! }, 'I stopped, as you asked.']]);

    // A conversation its owner left for a day ends, and a late reply hears so.
    next = () => 'Fine.';
    const old = await owner.send(direct, { text: 'Hello', prompt: asks() });
    await hear();
    await said();
    await conversations.sweep(Date.now() + 23 * 60 * 60_000);
    next = () => 'Still here.';
    await owner.send(direct, { text: 'Hello still', prompt: { kind: 'reply', to: old.clientId!, sentAt: Date.now() } });
    await hear();
    assert.deepEqual(await said(), [[{ kind: 'answer', to: old.clientId! }, 'Still here.']]);
    await conversations.sweep(Date.now() + 25 * 60 * 60_000);
    await owner.send(direct, { text: 'Hello again', prompt: { kind: 'reply', to: old.clientId!, sentAt: Date.now() } });
    const turns = calls.length;
    await hear();
    assert.equal(calls.length, turns);
    assert.deepEqual(await said(), [[{ kind: 'failed', to: old.clientId! }, 'This conversation ended after a day with no reply. Start a new one.']]);

    // A restart that cut a turn short says so, and the next turn starts afresh.
    const file = path.join(w.home, 'talker-recover.json');
    const cut = { root: randomUUID(), chat: direct, session: randomUUID(), answered: false, prompt: 'Cut short', working: true, last: Date.now() };
    await fs.writeFile(file, JSON.stringify([cut]));
    const restarted = new Conversations(agent, file, answer);
    await restarted.load();
    await restarted.recover();
    assert.deepEqual(await said(), [[{ kind: 'failed', to: cut.root }, 'I stopped, because Claude Code closed on your laptop. Send it again.']]);
    const [saved] = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(!saved.working && saved.session !== cut.session, 'a fresh session');
  });

  test("asks its owner before an action its harness asks about, and goes on with the owner's signed answer from another device (docs/decisions/harness-approvals.md)", { timeout: 60_000 }, async () => {
    const dataDir = path.join(w.home, 'asker', 'laptop');
    // A harness that asks before it runs a command, and runs it only when told to.
    const turns: Array<{ cwd: string; asked: boolean; reply?: Reply }> = [];
    const fake = {
      name: 'Fake',
      asks: true,
      refusal: async () => undefined,
      offers: () => ({ knobs: [] }),
      found: async () => ({ path: '/fake' }),
      apply: async () => undefined,
      async turn(t) {
        const entry: (typeof turns)[number] = { cwd: t.cwd, asked: !!t.ask };
        turns.push(entry);
        if (t.ask) {
          entry.reply = await t.ask({ tool: 'Bash', kind: 'execute', paths: [], detail: 'npm test' });
          if (entry.reply.allow) await fs.writeFile(path.join(t.cwd, 'ran.txt'), 'x');
        }
        return { reply: entry.reply?.allow ? 'It ran.' : 'It did not run.' };
      },
    } as Harness;
    const code = newPairingCode();
    const plugin = new Plugin({ harnesses: [fake], cloneRoot: path.join(w.home, 'WebChat'), dataDir, code: `${w.baseUrl}#${code}` });
    const starting = plugin.start();
    const agent = await approve(w.alice, code, 'Asker');
    assert.equal(await starting, true);
    await w.alice.sync();
    const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).id;
    const project = (await w.alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Asks', memberIds: [agent.id], key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).project.id;
    // Alice's second device: the same account, signed in again.
    await fs.copyFile(path.join(w.home, 'alice.json'), path.join(w.home, 'alice-phone.json'));
    const phone = await AgentClient.load(path.join(w.home, 'alice-phone.json'));
    await w.alice.sync();
    await plugin.client!.sync();

    const prompt = async (asks: boolean) => {
      await w.alice.send(direct, { text: 'Run the tests', prompt: { kind: 'prompt', sentAt: Date.now(), project, ...(asks && { asks: true as const }) } });
      // Not awaited: the turn waits for the owner.
      for (const m of await plugin.client!.sync()) void plugin.handle(m);
    };
    // Everything each reader heard from the agent, since a sync returns a message once.
    const heard = new Map<AgentClient, OpenedMessage[]>();
    const fromAgent = async (reader: AgentClient) => {
      const list = heard.get(reader) ?? [];
      heard.set(reader, list);
      list.push(...(await reader.sync()).filter((m) => m.senderId === agent.id));
      return list;
    };
    /** The nth question the agent asked, once it reaches the reader. */
    const question = async (reader: AgentClient, n: number) => {
      let found: OpenedMessage | undefined;
      await waitFor('the question reaches the owner', async () => !!(found = (await fromAgent(reader)).filter((m) => m.content?.permit?.kind === 'question')[n]));
      return found!;
    };
    const answer = async (to: OpenedMessage, decision: 'once' | 'run' | 'deny', from: AgentClient = phone) => {
      const asked = to.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
      await from.send(direct, { text: 'Answer', permit: { kind: 'answer', to: to.clientId!, decision, seen: await permitHash(asked), sentAt: Date.now() } });
      for (const m of await plugin.client!.sync()) await plugin.handle(m);
    };
    const replies = async () => (await fromAgent(w.alice)).filter((m) => m.content?.prompt?.kind === 'answer' || m.content?.prompt?.kind === 'failed').map((m) => m.content!.text);

    // The owner's page can show a question: it asks, sealed, and Alice's second device answers.
    await prompt(true);
    const asked = await question(phone, 0);
    const permit = asked.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
    assert.deepEqual([permit.what, permit.detail, typeof permit.to, asked.content!.text.split('\n')[0]], ['run', 'npm test', 'string', 'Your agent asks your permission to run a command:']);
    const [row] = await w.instance.sql.query<Record<string, unknown>>('SELECT * FROM webchat.messages WHERE id = $1', [asked.id]);
    assert.ok(!JSON.stringify(row).includes('npm test') && !JSON.stringify(row).includes('permission'), 'the server holds the question sealed');
    assert.equal(turns.at(-1)!.reply, undefined, 'the turn waits for the answer');
    await answer(asked, 'once');
    await waitFor('the turn goes on', async () => (await replies()).includes('It ran.'));
    await fs.access(path.join(turns.at(-1)!.cwd, 'ran.txt'));
    assert.deepEqual((await fromAgent(phone)).map((m) => m.content?.permit?.kind).filter(Boolean), ['question', 'settled'], 'the second device learns it was answered');
    // The answer counts once: sent again, it changes nothing.
    await answer(asked, 'deny');
    assert.equal((await replies()).filter((r) => r === 'It did not run.').length, 0);

    // Deny stops that action, and the turn still ends with its answer.
    await prompt(true);
    await answer(await question(phone, 1), 'deny');
    await waitFor('the turn ends', async () => (await replies()).includes('It did not run.'));
    assert.equal(existsSync(path.join(turns.at(-1)!.cwd, 'ran.txt')), false, 'the action did not run');
    assert.deepEqual(turns.at(-1)!.reply, { allow: false, message: 'Your owner said no. Do not try it again: do something else, or stop.' });

    // A page from before questions sets no flag: nothing is asked, and the harness gets no way to ask.
    const quiet = turns.length;
    const permitted = async () => (await fromAgent(w.alice)).filter((m) => m.content?.permit).length;
    const before = await permitted();
    await prompt(false);
    await waitFor('the turn ran', async () => turns.length === quiet + 1);
    assert.equal(turns.at(-1)!.asked, false);
    assert.equal(await permitted(), before, 'no question was posted');

    // A question that waits 7 days ends the turn, and says so.
    await prompt(true);
    await question(w.alice, 2);
    await plugin.pollPulls(Date.now() + 8 * 24 * 60 * 60_000);
    await waitFor('the turn failed', async () => (await replies()).includes('I could not answer. No answer came within 7 days.'));
    assert.ok((await fromAgent(w.alice)).some((m) => m.content?.permit?.kind === 'settled' && m.content.permit.outcome === 'expired'));
  });
}
