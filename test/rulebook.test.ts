import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { judge, type Action, type Rules } from '../agent/rulebook.ts';

describe('the rulebook', () => {
  let root: string;
  let rules: Rules;
  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-rulebook-')));
    await Promise.all(['work', 'keys', 'other'].map((dir) => fs.mkdir(path.join(root, dir))));
    await fs.symlink(path.join(root, 'keys'), path.join(root, 'work', 'link'));
    rules = { folders: [path.join(root, 'work')], secrets: [path.join(root, 'keys')], tools: ['submit_answer'] };
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  const inside = () => path.join(root, 'work', 'sum.js');
  const verdict = (action: Partial<Action>) => judge({ kind: 'other', paths: [], ...action }, rules);

  test('lets an agent read, search and think in its folder, and use its own web tools', () => {
    for (const kind of ['read', 'search', 'think', 'fetch'] as const) assert.deepEqual(verdict({ kind, paths: kind === 'read' ? [inside()] : [] }), { allow: true });
  });

  test('lets it change files in its folder, but asks when it names none', () => {
    for (const kind of ['edit', 'delete', 'move'] as const) assert.deepEqual(verdict({ kind, paths: [inside()] }), { allow: true });
    assert.equal(verdict({ kind: 'edit' }).allow, false);
    assert.equal((verdict({ kind: 'edit' }) as { ask?: true }).ask, true);
  });

  test('denies a path outside the folder, whatever the kind, and a secret by its own reason', () => {
    const outside = verdict({ kind: 'read', paths: [path.join(root, 'other', 'a')] });
    assert.deepEqual([outside.allow, (outside as { ask?: true }).ask], [false, undefined]);
    const secret = verdict({ kind: 'search', paths: [path.join(root, 'keys', 'account.json')] });
    assert.equal(secret.allow, false);
    assert.match((secret as { why: string }).why, /secrets/);
    // A path that is relative to nothing, or climbs out with `..`, is outside too.
    assert.equal(verdict({ kind: 'read', paths: [path.join(root, 'work', '..', 'other')] }).allow, false);
  });

  test('denies a link that leads out of the folder into the secrets', () => {
    const through = verdict({ kind: 'read', paths: [path.join(root, 'work', 'link', 'account.json')] });
    assert.equal(through.allow, false);
    assert.match((through as { why: string }).why, /secrets/);
  });

  test('allows only WebChat\'s own tool, by the name a harness may prefix, and asks about any other', () => {
    for (const tool of ['submit_answer', 'mcp__webchat__submit_answer', 'webchat: submit_answer']) assert.deepEqual(verdict({ tool }), { allow: true });
    for (const tool of ['mcp__owner__send_email', 'xsubmit_answer', 'submit_answer2']) assert.equal((verdict({ tool }) as { ask?: true }).ask, true);
  });

  test('asks about a shell command, and never allows a change of mode', () => {
    assert.equal((verdict({ kind: 'execute' }) as { ask?: true }).ask, true);
    const mode = verdict({ kind: 'switch_mode' });
    assert.deepEqual([mode.allow, (mode as { ask?: true }).ask], [false, undefined]);
  });
});
