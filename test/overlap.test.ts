import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { overlaps, touches, type Pull } from '../scripts/overlap.ts';

const pull = (number: number, files: string[], body = '', headRefName = `claude/pr-${number}`): Pull => ({
  number,
  headRefName,
  body,
  files: files.map((path) => ({ path })),
});

describe('the overlap check in scripts/overlap.ts (docs/decisions/new-overlap-blocks.md)', () => {
  test('a pull request sharing a file with a lower-numbered open one fails with both named', () => {
    const open = [pull(12, ['server/api.ts', 'README.md']), pull(15, ['server/api.ts', 'client/src/app.ts'])];
    assert.deepEqual(overlaps(open[1], open), [{ number: 12, files: ['server/api.ts'] }]);
  });

  test('the lower-numbered pull request is not blocked by the later one', () => {
    const open = [pull(12, ['server/api.ts']), pull(15, ['server/api.ts'])];
    assert.deepEqual(overlaps(open[0], open), []);
  });

  test('After #12 or Stacked on #12 in the body passes it', () => {
    for (const body of ['After #12', 'Stacked on #12, since it uses its type.']) {
      const open = [pull(12, ['server/api.ts']), pull(15, ['server/api.ts'], body)];
      assert.deepEqual(overlaps(open[1], open), []);
    }
  });

  test('naming another pull request does not pass the overlap with #12', () => {
    const open = [pull(12, ['server/api.ts']), pull(13, ['server/db.ts']), pull(15, ['server/api.ts'], 'After #13')];
    assert.equal(overlaps(open[2], open)[0].number, 12);
  });

  test('two pull requests with no shared file both pass', () => {
    const open = [pull(12, ['server/api.ts']), pull(15, ['client/src/app.ts'])];
    assert.deepEqual(overlaps(open[0], open), []);
    assert.deepEqual(overlaps(open[1], open), []);
  });

  test('a pull request that only adds a roadmap or decision file passes', () => {
    const open = [
      pull(12, ['docs/roadmap/K-3.md', 'docs/decisions/new-x.md', 'server/api.ts']),
      pull(15, ['docs/roadmap/K-3.md', 'docs/decisions/new-x.md']),
    ];
    assert.deepEqual(overlaps(open[1], open), []);
  });

  test('the board copy and the release pull request never count, on either side', () => {
    const board = pull(5, ['README.md'], '', 'agent/board');
    const release = pull(6, ['package.json'], '', 'release-please--branches--main');
    const open = [board, release, pull(15, ['README.md', 'package.json'])];
    assert.deepEqual(overlaps(open[2], open), []);
    assert.deepEqual(overlaps(pull(20, ['README.md'], '', 'agent/board'), [pull(12, ['README.md']), board]), []);
    assert.deepEqual(overlaps(pull(20, ['package.json'], '', 'release-please--branches--main'), [pull(12, ['package.json'])]), []);
  });

  test('a draft with no diff yet holds the files of its Touches line', () => {
    const draft = pull(12, [], 'Claims K-12.\n\nTouches: server/api.ts, `client/src/`');
    assert.deepEqual(touches(draft.body ?? ''), ['server/api.ts', 'client/src/']);
    const open = [draft, pull(15, ['server/api.ts', 'client/src/chat.ts'])];
    assert.deepEqual(overlaps(open[1], open), [{ number: 12, files: ['client/src/chat.ts', 'server/api.ts'] }]);
    assert.deepEqual(overlaps(draft, [pull(8, ['server/api.ts']), draft]), [{ number: 8, files: ['server/api.ts'] }]);
  });

  test('once a draft has a diff, its Touches line no longer counts', () => {
    const open = [pull(12, ['README.md'], 'Touches: server/api.ts'), pull(15, ['server/api.ts'])];
    assert.deepEqual(overlaps(open[1], open), []);
  });

  test('the command prints the error and exits 1, and exits 0 when nothing is shared', () => {
    const open = JSON.stringify([pull(12, ['a.ts']), pull(15, ['a.ts']), pull(16, ['b.ts'])]);
    const run = (number: string) =>
      spawnSync('node', ['--import', 'tsx', 'scripts/overlap.ts', number], { input: open, encoding: 'utf8' });
    const blocked = run('15');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /#15 and the earlier #12 both change a\.ts/);
    assert.equal(run('16').status, 0);
  });
});
