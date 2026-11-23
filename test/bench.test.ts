// What the agent does in the owner's folders (docs/decisions/locked-room.md), with real git in folders here.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { LocalBench, PrerequisitesMissing } from '../agent/bench.ts';
import type { Harness } from '../agent/harness.ts';
import { Quiet } from '../agent/runner.ts';

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

  test('reads what an own session changes: its branch since the default one, and what is not committed (docs/roadmap/new-own-session-overlap.md)', async () => {
    // A checkout from a bundle has origin/main and no origin/HEAD.
    const dir = path.join(root, 'own');
    await bench.clone(dir, 'acme/app', await base('own'), 'origin/main');
    await git(dir, 'checkout', '-q', '-b', 'sums');
    await fs.writeFile(path.join(dir, 'sum.js'), 'sum\n');
    await git(dir, 'add', 'sum.js');
    await git(dir, 'commit', '-q', '-m', 'Sums');
    await fs.mkdir(path.join(dir, 'lib'));
    await fs.writeFile(path.join(dir, 'lib', 'new.js'), 'new\n');
    await fs.writeFile(path.join(dir, 'README.md'), '# Changed\n');
    const { branch, files } = await bench.changes(dir);
    assert.deepEqual([branch, files.sort()], ['sums', ['README.md', 'lib/new.js', 'sum.js']]);
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

  test('the rulebook refuses what it can alone, here where the owner\'s paths are, and leaves the rest to the permit', async () => {
    const work = path.join(root, 'rules-work');
    const keys = path.join(root, 'rules-keys');
    await fs.mkdir(work);
    await fs.mkdir(keys);
    const asked: string[] = [];
    // A harness that puts each action to the turn's ask, as an adapter does, and answers with what it was told.
    const harness = {
      name: 'Fake',
      turn: async (turn: Parameters<Harness['turn']>[0]) => {
        const actions = [
          { tool: 'Read', kind: 'read' as const, paths: ['/elsewhere/notes.txt'], detail: 'Read /elsewhere/notes.txt' },
          { tool: 'Bash', kind: 'execute' as const, paths: [path.join(keys, 'account.json')], detail: 'cat account.json' },
          { tool: 'Read', kind: 'read' as const, paths: [path.join(work, 'a.js')], detail: 'Read a.js' },
        ];
        return Promise.all(actions.map((action) => turn.ask!(action)));
      },
      offers: () => ({ knobs: [] }),
      apply: async () => undefined,
    } as unknown as Harness;
    const bench = new LocalBench([harness], undefined, keys);
    const { answer } = await bench.turn(
      { harness: 'Fake', cwd: work, session: 's', resume: false, message: '', schema: {}, schemas: [], setup: { claudeMd: false, skills: [], noAttribution: false } },
      { signal: new AbortController().signal, permit: () => ({ ask: async (action) => (asked.push(action.detail), { allow: true }), quiet: new Quiet(), done: () => undefined }) },
    );
    const replies = answer as Array<{ allow: boolean; message?: string }>;
    assert.deepEqual(replies.map((r) => r.allow), [false, false, true]);
    assert.match(replies[0]!.message!, /outside the working folder/);
    assert.match(replies[1]!.message!, /secrets/);
    assert.deepEqual(asked, ['Read a.js'], 'only what the rulebook would allow reaches the permit');
  });

  test('a command of a harness whose shell cannot leave its sandbox passes without the owner', async () => {
    const work = path.join(root, 'held-work');
    const keys = path.join(root, 'held-keys');
    await fs.mkdir(work);
    await fs.mkdir(keys);
    const run = async (sandboxed?: () => Promise<boolean>) => {
      const asked: string[] = [];
      const harness = {
        name: 'Fake',
        sandboxed,
        turn: async (turn: Parameters<Harness['turn']>[0]) =>
          Promise.all([
            { tool: 'Bash', kind: 'execute' as const, paths: [], detail: 'PORT=3001 npm test' },
            { tool: 'Bash', kind: 'execute' as const, paths: [path.join(keys, 'account.json')], detail: 'cat account.json' },
            { tool: 'Read', kind: 'read' as const, paths: [path.join(work, 'a.js')], detail: 'Read a.js' },
          ].map((action) => turn.ask!(action))),
        offers: () => ({ knobs: [] }),
        apply: async () => undefined,
      } as unknown as Harness;
      const { answer } = await new LocalBench([harness], undefined, keys).turn(
        { harness: 'Fake', cwd: work, session: 's', resume: false, message: '', schema: {}, schemas: [], setup: { claudeMd: false, skills: [], noAttribution: false } },
        { signal: new AbortController().signal, permit: () => ({ ask: async (action) => (asked.push(action.detail), { allow: true }), quiet: new Quiet(), done: () => undefined }) },
      );
      return { allowed: (answer as Array<{ allow: boolean }>).map((r) => r.allow), asked };
    };
    assert.deepEqual(await run(async () => true), { allowed: [true, false, true], asked: ['Read a.js'] }, 'the command passes, and one that names a secret is still refused');
    assert.deepEqual((await run(async () => false)).asked, ['PORT=3001 npm test', 'Read a.js']);
    assert.deepEqual((await run()).asked, ['PORT=3001 npm test', 'Read a.js'], 'a harness that does not say so keeps asking');
  });
});
