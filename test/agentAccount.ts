import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { claudeHarness } from '../agent/claude.ts';
import { AgentClient } from '../agent/client.ts';
import { Plugin } from '../agent/plugin.ts';
import { freeLock } from '../agent/pluginFiles.ts';
import { openDb, toUserDTO } from '../server/db.ts';
import { newPairingCode } from '../shared/e2ee.ts';
import { KDF_ROUNDS, PASSWORD, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function accountTests(w: World) {
  test('goes when its owner deletes their account (R-030)', async () => {
    const dave = await AgentClient.signUp(path.join(w.home, 'dave.json'), { server: w.baseUrl, username: 'dave', password: PASSWORD, kdfIterations: KDF_ROUNDS }, 'Dave', 'friends-only');
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(w.home, 'dave-agent.json'), w.baseUrl, code, 10);
    const agent = await approve(dave, code, 'Dave agent');
    await pairing;
    await dave.request('DELETE', '/auth/account');
    await w.alice.sync();
    assert.equal(w.alice.users.get(dave.id)?.deleted, true);
    assert.equal(w.alice.users.get(agent.id)?.deleted, true, 'nobody else may hand it cards');
  });

  test('is removed by its owner, and by nobody else (R-033)', async () => {
    const code = newPairingCode();
    const pairing = AgentClient.pair(path.join(w.home, 'spare.json'), w.baseUrl, code, 10);
    const spare = await approve(w.alice, code, 'Spare');
    const agent = await pairing;
    await assert.rejects(w.carol.request('DELETE', `/agents/${spare.id}`), { status: 404 });
    await w.alice.request('DELETE', `/agents/${spare.id}`);
    await w.alice.sync();
    assert.deepEqual([w.alice.users.get(spare.id)?.deleted, w.alice.users.get(spare.id)?.agentOwner], [true, null], 'no menu offers it');
    // Its session ends, and it cannot sign in again.
    await assert.rejects(agent.sync(), { status: 401 });
    await assert.rejects(w.alice.request('DELETE', `/agents/${spare.id}`), { status: 404 });
  });

  test('a removed agent stops serving and says so, rather than restart and use up the sign-in limit', async () => {
    const dataDir = path.join(w.home, 'removed', 'laptop');
    const code = newPairingCode();
    const plugin = new Plugin({ harnesses: [claudeHarness('', dataDir)], cloneRoot: path.join(w.home, 'WebChat'), dataDir, code: `${w.baseUrl}#${code}` });
    const starting = plugin.start();
    const agent = await approve(w.alice, code, 'Removed');
    assert.equal(await starting, true);
    await w.alice.request('DELETE', `/agents/${agent.id}`);
    freeLock(path.join(dataDir, 'watch.lock'));
    await plugin.serve();
    assert.match(plugin.problem, /setup/);
  });

  test('counts an agent online for 2 minutes after its check-in, a person for 1, on the page and in the sync fingerprint (docs/roadmap/new-agent-setup.md)', async () => {
    const db = await openDb(w.instance.sql);
    const seen = (id: number, ms: number) => w.instance.sql.query('UPDATE webchat.users SET last_active_at = $2 WHERE id = $1', [id, Date.now() - ms]);
    // The fingerprint's online part names the ids, and its repositories part hashes who is online by folder.
    const parts = async () => (await db.stamp(w.alice.id)).split('.');
    const onlineIds = async () => ((await parts())[9] ?? '').split(',');
    const dto = async (id: number) => toUserDTO((await db.listUsers()).find((row) => row.id === id)!);
    await w.instance.sql.query(`INSERT INTO webchat.agent_repos (user_id, repo, last_seen, protocol) VALUES ($1, 'acme/window', $2, 5)`, [w.bot.id, Date.now() - 90_000]);
    try {
      await seen(w.alice.id, 90_000);
      await seen(w.bot.id, 90_000);
      assert.deepEqual([(await dto(w.alice.id)).online, (await dto(w.bot.id)).online, (await dto(w.bot.id)).agentRepos[0]?.online], [false, true, true]);
      assert.deepEqual([(await onlineIds()).includes(String(w.alice.id)), (await onlineIds()).includes(String(w.bot.id))], [false, true]);
      const before = (await parts())[11];
      await seen(w.bot.id, 150_000);
      await w.instance.sql.query(`UPDATE webchat.agent_repos SET last_seen = $2 WHERE user_id = $1 AND repo = 'acme/window'`, [w.bot.id, Date.now() - 150_000]);
      assert.deepEqual([(await dto(w.bot.id)).online, (await dto(w.bot.id)).agentRepos[0]?.online], [false, false]);
      assert.equal((await onlineIds()).includes(String(w.bot.id)), false);
      assert.notEqual((await parts())[11], before, 'the page learns when a folder goes offline');
    } finally {
      await w.instance.sql.query(`DELETE FROM webchat.agent_repos WHERE repo = 'acme/window'`);
      await w.alice.sync();
    }
  });

  test('a folder the agent names while a page loads the people reaches the page at its next check-in (K-70)', async () => {
    await w.alice.sync();
    const query = w.instance.sql.query;
    // The agent's check-in lands just after the check-in's answer read the people, before it reads the fingerprint.
    w.instance.sql.query = async function <T>(this: unknown, text: string, params?: unknown[]) {
      const rows = await query.call(w.instance.sql, text, params);
      if (text.includes('FROM webchat.agent_repos r WHERE r.user_id = u.id')) {
        w.instance.sql.query = query;
        await query.call(w.instance.sql, `INSERT INTO webchat.agent_repos (user_id, repo, last_seen, protocol) VALUES ($1, 'acme/late', $2, 5)`, [w.bot.id, Date.now()]);
      }
      return rows as T[];
    };
    const seat = () => w.alice.users.get(w.bot.id)?.agentRepos.find((s) => s.repo === 'acme/late');
    try {
      await w.instance.sql.query(`UPDATE webchat.users SET last_active_at = $2 WHERE id = $1`, [w.bot.id, Date.now()]);
      await w.alice.sync();
      assert.equal(w.instance.sql.query, query, 'the agent checked in while the answer was built');
      await w.alice.sync();
      assert.equal(seat()?.online, true, 'the page shows the folder Ready without a reload');
    } finally {
      w.instance.sql.query = query;
      await w.instance.sql.query(`DELETE FROM webchat.agent_repos WHERE repo = 'acme/late'`);
      await w.alice.sync();
    }
  });

  test('waits for the interval it is asked for before each check-in', async () => {
    const stop = new AbortController();
    let rounds = 0;
    for await (const message of w.alice.watch(stop.signal, () => (++rounds === 3 && stop.abort(), 5))) assert.ok(message);
    assert.equal(rounds, 3);
  });
}
