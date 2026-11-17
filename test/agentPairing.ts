import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Api } from '../agent/api.ts';
import { AgentClient } from '../agent/client.ts';
import { createIdentity, keyFingerprint, newPairingCode, pairingId, pairingProof, openPicks, sealPicks } from '../shared/e2ee.ts';
import { type ConversationDTO, type CreateProjectResponse, type PairingDTO } from '../shared/types.ts';
import { KDF_ROUNDS, PASSWORD, newChatKey, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function pairingTests(w: World) {
  test('pairs with its owner through a one-time code, and keeps its keys in a file only its owner can read (R-030)', async () => {
    // A person, who signs up in a browser; the client stands in for the page here.
    w.alice = await AgentClient.signUp(path.join(w.home, 'alice.json'), { server: w.baseUrl, username: 'alice', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Alice', 'friends-only');
    const code = newPairingCode();
    // However it is pasted, it is the same code.
    assert.equal(await pairingId(code.toUpperCase().replace(/-/g, ' ')), await pairingId(code));
    const pairing = AgentClient.pair(w.botFile, w.baseUrl, code, 10);
    const approved = await approve(w.alice, code, 'Bot');
    w.bot = await pairing;
    assert.equal(w.bot.id, approved.id);
    assert.equal(w.bot.owner, w.alice.id);
    assert.equal((await fs.stat(w.botFile)).mode & 0o777, 0o600);
    const file = JSON.parse(await fs.readFile(w.botFile, 'utf8'));
    assert.deepEqual(Object.keys(file).sort(), ['authKey', 'cookie', 'cursor', 'owner', 'pairing', 'pins', 'secrets', 'server', 'userId', 'username']);
    // The owner's keys came with the code, so they are pinned before any check-in.
    assert.deepEqual(file.pins, { [w.alice.id]: await keyFingerprint(w.alice.identity.publicKeys) });
    // Alice's board offers the bot, as hers.
    await w.alice.sync();
    assert.equal(w.alice.users.get(w.bot.id)?.agentOwner, w.alice.id);

    // A code works once.
    const keys = w.bot.identity.publicKeys;
    const again = { id: await pairingId(code), keys, proof: await pairingProof(code, keys), authKey: 'x'.repeat(43) };
    await assert.rejects(new Api(w.baseUrl).request('POST', '/pairings', again), { status: 409 });
    // An approval that the code does not prove, as from a server that swapped the owner's keys, pairs nothing.
    const other = newPairingCode();
    const forged = AgentClient.pair(path.join(w.home, 'forged.json'), w.baseUrl, other, 10);
    await approve(w.alice, other, 'Forged', await pairingProof(newPairingCode(), keys, { id: w.alice.id, keys: w.alice.identity.publicKeys }));
    await assert.rejects(forged, /does not match the pairing code/);
    // The agent's login key never travels in the clear, except on this machine, whatever its name (K-48).
    assert.throws(() => new Api('http://chat.example.com'), /https/);
    assert.throws(() => new Api('http://localhost.example.com'), /https/);
    for (const local of ['http://localhost:5173', 'http://alice.localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:3000']) new Api(local);
  });

  test('a pairing carries the sealed picks, within the limits, and the page reads them back', async () => {
    await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'pair:%'");
    const code = newPairingCode();
    const { publicKeys: keys } = await createIdentity();
    const picks = await sealPicks(code, keys, [{ name: 'Codex', signedIn: false }]);
    const half = async (extra: object) => ({ id: await pairingId(newPairingCode()), keys, proof: await pairingProof(code, keys), authKey: 'x'.repeat(43), ...extra });
    for (const bad of ['', 'not base64!', 'a'.repeat(4097), 'short']) {
      await assert.rejects(new Api(w.baseUrl).request('POST', '/pairings', await half({ picks: bad })), { status: 400 }, `picks ${bad.slice(0, 12)}`);
    }
    const input = { ...(await half({ picks })), id: await pairingId(code) };
    await new Api(w.baseUrl).request('POST', '/pairings', input);
    const read = await new Api(w.baseUrl).request<PairingDTO>('GET', `/pairings/${input.id}`);
    assert.deepEqual(await openPicks(code, read.keys, read.picks!), [{ name: 'Codex', signedIn: false }]);
    // A pairing with none, as an agent from before linking files it, reads as before.
    const plain = await half({});
    await new Api(w.baseUrl).request('POST', '/pairings', plain);
    assert.equal((await new Api(w.baseUrl).request<PairingDTO>('GET', `/pairings/${plain.id}`)).picks, undefined);
    // The tests after this one pair too, and the limit is per address.
    await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'pair:%'");
  });

  test('reads and answers in a project it was added to', async () => {
    // A teammate the bot takes no cards from.
    w.carol = await AgentClient.signUp(path.join(w.home, 'carol.json'), { server: w.baseUrl, username: 'carol', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Carol', 'friends-only');
    await w.alice.sync();
    const key = await newChatKey(w.alice, [w.alice.id, w.bot.id, w.carol.id]);
    const created = await w.alice.request<CreateProjectResponse>('POST', '/projects', { name: 'Capstone', memberIds: [w.bot.id, w.carol.id], key });
    w.projectId = created.project.id;
    w.generalId = created.channel.id;
    await w.alice.sync();
    await w.alice.send(w.generalId, { text: 'Hello bot' });

    const heard = await w.bot.sync();
    assert.equal(w.bot.conversations.get(w.generalId)?.projectId, w.projectId);
    assert.deepEqual(
      heard.map((m) => [m.senderId, m.security, m.content?.text]),
      [[w.alice.id, 'encrypted', 'Hello bot']],
    );

    await w.bot.send(w.generalId, { text: 'Hi Alice' });
    assert.deepEqual((await w.alice.sync()).map((m) => [m.senderId, m.content?.text]), [[w.bot.id, 'Hi Alice']]);
    // Its own message, and the overlap of the check-in before, come back as nothing new.
    assert.deepEqual(await w.bot.sync(), []);
  });

  test('never owns a project or group, since it cannot remove, hand back or delete (K-67)', async () => {
    await assert.rejects(w.alice.request('PUT', `/projects/${w.projectId}/owner`, { userId: w.bot.id }), { status: 400 });
    const key = await newChatKey(w.alice, [w.alice.id, w.bot.id]);
    const group = await w.alice.request<ConversationDTO>('POST', '/conversations/group', { title: 'Pair', memberIds: [w.bot.id], key });
    await assert.rejects(w.alice.request('PUT', `/conversations/${group.id}/owner`, { userId: w.bot.id }), { status: 400 });
  });
}
