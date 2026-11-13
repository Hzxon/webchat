// The keyholder's own clone of a repository, and what it takes of a run's work (docs/decisions/locked-room.md):
// real git against bare repositories here, which stand in for GitHub through git's `insteadOf`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Keep, repoHome } from '../agent/keep.ts';

const sh = promisify(execFile);
const REPO = 'acme/app';

describe("the keyholder's clone", () => {
  let root: string;
  let data: string;
  let origin: string;
  let work: string;
  let keep: Keep;
  let base: { ref: string; tip: string };
  let global: string | undefined;
  const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args]).then((r) => r.stdout.trim());
  const atOrigin = (...args: string[]) => sh('git', ['--git-dir', origin, ...args]).then((r) => r.stdout.trim());
  const inClone = (...args: string[]) => sh('git', ['--git-dir', path.join(repoHome(data, REPO), 'git'), ...args]).then((r) => r.stdout.trim());
  /** Makes `git` here treat GitHub's address of a repository as a bare repository of the test's. */
  const stand = (repo: string, bare: string) => fs.appendFile(process.env.GIT_CONFIG_GLOBAL!, `[url "${bare}"]\n\tinsteadOf = https://github.com/${repo}.git\n`);
  /** A run's work as the runner sends it: the commits of `branch` after `since`, and any other ref named. */
  async function bundle(name: string, branch: string, since: string, ...more: string[]) {
    const file = path.join(root, `${name}.bundle`);
    await git(work, 'bundle', 'create', '-q', file, `refs/heads/${branch}`, ...more, `^${since}`);
    return file;
  }
  const commit = async (branch: string, file: string, from: string) => {
    await git(work, 'switch', '-q', '-C', branch, from);
    await fs.writeFile(path.join(work, file), `${file}\n`);
    await git(work, 'add', file);
    await git(work, 'commit', '-q', '-m', `Add ${file}`);
    return git(work, 'rev-parse', 'HEAD');
  };

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-keep-')));
    [data, origin, work] = [path.join(root, 'data'), path.join(root, 'origin.git'), path.join(root, 'work')];
    global = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
    await stand(REPO, origin);
    await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    await sh('git', ['clone', '-q', origin, work]);
    await fs.writeFile(path.join(work, 'README.md'), '# App\n');
    await git(work, 'add', 'README.md');
    await git(work, 'commit', '-q', '-m', 'Start');
    await git(work, 'push', '-q', 'origin', 'main');
    keep = new Keep({ dataDir: data });
    base = await keep.fetch(REPO);
  });
  after(async () => {
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = global;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('keeps a bare clone of its own with no hooks, and names the default branch and its commit', async () => {
    assert.equal(base.ref, 'origin/main');
    assert.equal(base.tip, await git(work, 'rev-parse', 'main'));
    assert.equal(await inClone('rev-parse', '--is-bare-repository'), 'true');
    assert.equal((await fs.readdir(path.join(repoHome(data, REPO), 'git'))).includes('hooks'), false);
  });

  test("takes a bundle of exactly the run's agent branch, and pushes it without force", async () => {
    const head = await commit('agent/k-1-good', 'a.txt', base.tip);
    assert.equal(await keep.acceptBundle(REPO, await bundle('good', 'agent/k-1-good', base.tip), { branch: 'agent/k-1-good', since: base.tip }), head);
    assert.equal(await atOrigin('rev-parse', '--verify', '-q', 'refs/heads/agent/k-1-good').catch(() => ''), '', 'taking it pushes nothing');
    await keep.push(REPO, 'agent/k-1-good');
    assert.equal(await atOrigin('rev-parse', 'refs/heads/agent/k-1-good'), head);
    assert.ok((await keep.branches(REPO)).includes('agent/k-1-good'));
    // A later round on top of it.
    const next = await commit('agent/k-1-good', 'b.txt', head);
    assert.equal(await keep.acceptBundle(REPO, await bundle('round', 'agent/k-1-good', head), { branch: 'agent/k-1-good', since: head }), next);
  });

  test('refuses a bundle that moves main, mixes in another ref, or is for another branch, and moves nothing', async () => {
    await commit('main', 'moved.txt', base.tip);
    const moves = await bundle('main', 'main', base.tip);
    await git(work, 'switch', '-q', '-C', 'main', base.tip);
    await assert.rejects(keep.acceptBundle(REPO, moves, { branch: 'main', since: base.tip }), /no branch an agent may push/);
    await assert.rejects(keep.acceptBundle(REPO, moves, { branch: 'agent/k-2', since: base.tip }), /holds more than/);

    await commit('agent/k-2-mixed', 'm.txt', base.tip);
    await git(work, 'branch', '-f', 'agent/k-2-other', 'agent/k-2-mixed');
    const mixed = await bundle('mixed', 'agent/k-2-mixed', base.tip, 'refs/heads/agent/k-2-other');
    await assert.rejects(keep.acceptBundle(REPO, mixed, { branch: 'agent/k-2-mixed', since: base.tip }), /holds more than/);
    const other = await bundle('other', 'agent/k-2-other', base.tip);
    await assert.rejects(keep.acceptBundle(REPO, other, { branch: 'agent/k-2-mixed', since: base.tip }), /holds more than/);
    assert.deepEqual((await keep.branches(REPO)).filter((b) => b.startsWith('agent/k-2')), []);
    assert.equal((await keep.fetch(REPO)).tip, base.tip, 'main stays');
  });

  test('refuses a bundle that rewinds its branch, or does not start from where the run began', async () => {
    const first = await commit('agent/k-3-rewind', 'one.txt', base.tip);
    await keep.acceptBundle(REPO, await bundle('one', 'agent/k-3-rewind', base.tip), { branch: 'agent/k-3-rewind', since: base.tip });
    const second = await commit('agent/k-3-rewind', 'two.txt', first);
    await keep.acceptBundle(REPO, await bundle('two', 'agent/k-3-rewind', first), { branch: 'agent/k-3-rewind', since: first });
    // The branch from its start again, with a different commit: the second one is left out.
    await commit('agent/k-3-rewind', 'other.txt', base.tip);
    await assert.rejects(keep.acceptBundle(REPO, await bundle('rewound', 'agent/k-3-rewind', base.tip), { branch: 'agent/k-3-rewind', since: base.tip }), /would drop commits/);
    assert.equal(await inClone('rev-parse', 'refs/heads/agent/k-3-rewind'), second, 'the branch stays where it was');
    // Not on top of what the run says it began from.
    await commit('agent/k-3-since', 'since.txt', base.tip);
    await assert.rejects(keep.acceptBundle(REPO, await bundle('since', 'agent/k-3-since', base.tip), { branch: 'agent/k-3-since', since: first }), /does not start from/);
    assert.equal(await inClone('rev-parse', '--verify', '-q', 'refs/heads/agent/k-3-since').catch(() => ''), '');
  });

  test('takes a bundle when a stopped accept left its incoming ref behind', async () => {
    const left = await commit('agent/k-6-left', 'left.txt', base.tip);
    await keep.acceptBundle(REPO, await bundle('left', 'agent/k-6-left', base.tip), { branch: 'agent/k-6-left', since: base.tip });
    // As a keyholder killed between its fetch and its cleanup leaves it.
    await inClone('update-ref', 'refs/webchat/incoming', left);
    const head = await commit('agent/k-6-fresh', 'fresh.txt', base.tip);
    assert.equal(await keep.acceptBundle(REPO, await bundle('fresh', 'agent/k-6-fresh', base.tip), { branch: 'agent/k-6-fresh', since: base.tip }), head);
  });

  test('refuses a bundle that is too large, or changed on its way', async () => {
    await commit('agent/k-4-big', 'big.txt', base.tip);
    const file = await bundle('big', 'agent/k-4-big', base.tip);
    const small = new Keep({ dataDir: data, maxBundle: 10 });
    await assert.rejects(small.acceptBundle(REPO, file, { branch: 'agent/k-4-big', since: base.tip }), /too large/);
    const reported = { bytes: (await fs.stat(file)).size, sha256: '0'.repeat(64) };
    await assert.rejects(keep.acceptBundle(REPO, file, { branch: 'agent/k-4-big', since: base.tip, reported }), /changed on its way/);
  });

  test('refuses a bundle whose objects fail fsck', async () => {
    // A commit with no email in its author line, which git's own tools never write.
    const tree = await git(work, 'rev-parse', `${base.tip}^{tree}`);
    const text = path.join(root, 'broken-commit');
    await fs.writeFile(text, `tree ${tree}\nparent ${base.tip}\nauthor Mallory 0 +0000\ncommitter Mallory 0 +0000\n\nBroken\n`);
    await git(work, 'update-ref', 'refs/heads/agent/k-5-fsck', await git(work, 'hash-object', '-t', 'commit', '--literally', '-w', text));
    await assert.rejects(keep.acceptBundle(REPO, await bundle('fsck', 'agent/k-5-fsck', base.tip), { branch: 'agent/k-5-fsck', since: base.tip }), /fsck|badEmail|missingEmail|invalid/i);
    assert.equal((await keep.branches(REPO)).includes('agent/k-5-fsck'), false);
  });

  test('sends the whole default branch when the runner cannot have its base', async () => {
    const more = await commit('main', 'more.txt', base.tip);
    await git(work, 'push', '-q', 'origin', 'main');
    const now = await keep.fetch(REPO);
    assert.equal(now.tip, more);
    const empty = path.join(root, 'empty');
    await sh('git', ['init', '-q', empty]);
    const verifies = (file: string) => sh('git', ['-C', empty, 'bundle', 'verify', '-q', file]).then(() => true, () => false);
    const part = path.join(root, 'part.bundle');
    await keep.baseBundle(REPO, part, now.ref, base.tip);
    assert.equal(await verifies(part), false, 'from a commit the runner has, it holds only what is new');
    const full = path.join(root, 'full.bundle');
    await keep.baseBundle(REPO, full, now.ref, '1'.repeat(40));
    assert.equal(await verifies(full), true, 'from a commit the clone lacks, it holds all');
    const again = path.join(root, 'again.bundle');
    await keep.baseBundle(REPO, again, now.ref, now.tip);
    assert.equal(await verifies(again), true, 'with nothing new, it holds all');
  });

  test("writes the board's copy with plumbing, merged with the default branch and without a proposal the board holds", async () => {
    const files = { 'docs/roadmap.md': '### R-1: First\n', 'docs/decisions.md': '### D-1: Why\n' };
    const copy = (ref: string, remove: string[] = []) => keep.commitFiles(REPO, { branch: 'agent/board', base: ref, files, remove, message: 'docs: Copy the board' });
    const show = (file: string) => atOrigin('show', `agent/board:${file}`);
    const was = await keep.fetch(REPO);
    assert.ok(await copy(was.ref));
    await keep.push(REPO, 'agent/board');
    assert.equal(await show('docs/roadmap.md'), '### R-1: First');
    assert.equal(await copy(was.ref), undefined, 'a copy that changes nothing commits nothing');
    assert.equal(await keep.ahead(REPO, was.ref, 'agent/board'), 1);
    // The default branch moves on, with a proposal that the board holds since.
    await git(work, 'switch', '-q', 'main');
    await fs.mkdir(path.join(work, 'docs', 'roadmap'), { recursive: true });
    await fs.writeFile(path.join(work, 'docs', 'roadmap', 'new-idea.md'), '### R: Idea\n');
    await git(work, 'add', '.');
    await git(work, 'commit', '-q', '-m', 'Propose an idea');
    await git(work, 'push', '-q', 'origin', 'main');
    const now = await keep.fetch(REPO);
    assert.ok(await copy(now.ref, ['docs/roadmap/new-idea.md']));
    await keep.push(REPO, 'agent/board');
    assert.equal((await atOrigin('log', '-1', '--format=%P', 'agent/board')).split(' ').length, 2, 'the new commit merges the default branch in, so the push is no force');
    assert.equal(await show('README.md'), '# App');
    await assert.rejects(show('docs/roadmap/new-idea.md'), 'the proposal is gone from the copy');
    assert.ok(await keep.docFiles(REPO, now.ref).then((files) => files.some((f) => f.path === 'docs/roadmap/new-idea.md')), 'and still on the default branch');
  });

  test('refuses a board copy where a link stands at docs, and writes nothing through it', async () => {
    const link = 'acme/link';
    const [linked, outside, clone] = [path.join(root, 'link.git'), path.join(root, 'outside'), path.join(root, 'link')];
    await stand(link, linked);
    await sh('git', ['init', '-q', '--bare', '-b', 'main', linked]);
    await sh('git', ['clone', '-q', linked, clone]);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(clone, 'docs'));
    await git(clone, 'add', 'docs');
    await git(clone, 'commit', '-q', '-m', 'Link docs elsewhere');
    await git(clone, 'push', '-q', 'origin', 'main');
    const { ref } = await keep.fetch(link);
    await assert.rejects(keep.commitFiles(link, { branch: 'agent/board', base: ref, files: { 'docs/roadmap.md': 'x\n' }, remove: [], message: 'docs: Copy the board' }), /docs\/roadmap\.md/);
    assert.deepEqual(await fs.readdir(outside), [], 'nothing was written through the link');
    assert.deepEqual(await fs.readdir(repoHome(data, link)), ['git'], 'and nothing was checked out beside the clone');
  });
});
