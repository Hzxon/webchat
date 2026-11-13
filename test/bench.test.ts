// What the agent does in the owner's folders (docs/decisions/locked-room.md), with real git in folders here.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { LocalBench, PrerequisitesMissing } from '../agent/bench.ts';

const sh = promisify(execFile);

describe('the bench', () => {
  let root: string;
  let source: string;
  const bench = new LocalBench([]);
  const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
  const identity = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const was = identity.map((name) => process.env[name]);
  const commit = async (file: string, text: string, message: string) => {
    await fs.writeFile(path.join(source, file), text);
    await git(source, 'add', file);
    await git(source, 'commit', '-q', '-m', message);
    return git(source, 'rev-parse', 'HEAD');
  };

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-bench-')));
    identity.forEach((name) => (process.env[name] = name.endsWith('NAME') ? 'Alice' : 'alice@example.com'));
    source = path.join(root, 'source');
    await sh('git', ['init', '-q', '-b', 'main', source]);
    await commit('README.md', '# App\n', 'Start');
  });
  after(async () => {
    identity.forEach((name, i) => (was[i] === undefined ? delete process.env[name] : (process.env[name] = was[i])));
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A bundle of the source's main as the keyholder cuts it: the one ref, as a remote branch. */
  async function base(name: string, ...exclude: string[]) {
    const file = path.join(root, `${name}.bundle`);
    await git(source, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(source, 'bundle', 'create', '-q', file, 'refs/remotes/origin/main', ...exclude);
    return file;
  }

  test('makes a checkout from a bundle, and takes the next one into it, or says it lacks what that builds on', async () => {
    const first = await git(source, 'rev-parse', 'main');
    const dir = path.join(root, 'checkout');
    await bench.clone(dir, 'acme/app', await base('first'), 'origin/main');
    assert.equal(await git(dir, 'config', '--get', 'remote.origin.url'), 'https://github.com/acme/app.git');
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), first);
    assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
    assert.deepEqual((await bench.checkout(dir)), { exists: true, repo: 'acme/app' });

    const second = await commit('two.txt', 'two\n', 'Two');
    await bench.take(dir, await base('second', `^${first}`), 'origin/main');
    assert.equal(await git(dir, 'rev-parse', 'origin/main'), second);
    assert.equal(await git(dir, 'rev-parse', 'HEAD'), first, 'the owner\'s own branch stays where it is');

    const third = await commit('three.txt', 'three\n', 'Three');
    const elsewhere = path.join(root, 'elsewhere');
    await sh('git', ['init', '-q', elsewhere]);
    await assert.rejects(bench.take(elsewhere, await base('third', `^${second}`), 'origin/main'), PrerequisitesMissing);
    await bench.take(elsewhere, await base('whole'), 'origin/main');
    assert.equal(await git(elsewhere, 'rev-parse', 'origin/main'), third);
    assert.deepEqual(await bench.checkout(path.join(root, 'nothing')), { exists: false, repo: null });
  });

  test('commits what a harness that cannot commit left, by name, and nothing when it left none', async () => {
    const dir = path.join(root, 'work');
    await bench.clone(dir, 'acme/app', await base('work'), 'origin/main');
    const tip = await git(dir, 'rev-parse', 'origin/main');
    const { branch, worktree } = await bench.prepare({ dir, slug: 'k-7-sums', taken: [], tip });
    assert.equal(branch, 'agent/k-7-sums');
    assert.ok(worktree.startsWith(path.join(dir, '.claude', 'worktrees')));
    const empty = await bench.commit({ worktree, message: 'chore: Claim K-7', allowEmpty: true });
    assert.equal(await bench.commit({ worktree, message: 'Nothing', leftovers: true }), empty, 'no leftovers, no commit');

    await fs.writeFile(path.join(worktree, 'README.md'), '# Changed\n');
    await fs.writeFile(path.join(worktree, 'new.txt'), 'new\n');
    await fs.mkdir(path.join(worktree, 'src'));
    await fs.writeFile(path.join(worktree, 'src', 'a b.js'), 'x\n');
    await fs.rm(path.join(worktree, 'two.txt'));
    const head = await bench.commit({ worktree, message: 'Fix sums', leftovers: true });
    assert.notEqual(head, empty);
    assert.equal(await git(worktree, 'log', '-1', '--format=%s'), 'Fix sums');
    assert.deepEqual((await git(worktree, 'show', '--name-status', '--format=', 'HEAD')).split('\n').sort(), ['A\tnew.txt', 'A\tsrc/a b.js', 'D\ttwo.txt', 'M\tREADME.md'].sort());
    assert.equal(await git(worktree, 'status', '--porcelain'), '');

    // Its commits leave as a bundle of its branch alone, after what was sent before.
    const file = path.join(root, 'work-out.bundle');
    assert.equal(await bench.bundle({ worktree, branch, since: head, file }), undefined, 'nothing new since the head');
    const made = await bench.bundle({ worktree, branch, since: tip, file });
    assert.equal(made?.head, head);
    assert.equal((await git(dir, 'bundle', 'list-heads', file)).split('\n').map((l) => l.split(' ')[1]).join(), `refs/heads/${branch}`);
    await assert.rejects(bench.bundle({ worktree, branch: 'agent/other', since: tip, file }), /not on agent\/other/);
    assert.equal(await bench.prepare({ dir, slug: 'k-7-sums', taken: ['agent/k-7-sums-2'], tip }).then((p) => p.branch), 'agent/k-7-sums-3', 'a name here or taken elsewhere is skipped');
  });
});
