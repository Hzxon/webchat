import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const script = path.resolve('scripts/ignore-build.sh');

describe("Vercel's Ignored Build Step in scripts/ignore-build.sh (D-058)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-ignore-build-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  const commit = (file: string) => {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.appendFileSync(path.join(repo, file), 'change\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', `Change ${file}`);
    return git('rev-parse', 'HEAD');
  };
  /** Exit 0 skips the build, and exit 1 runs it. */
  const skips = (previous: string, message = 'fix: Change something') =>
    spawnSync('sh', [script], {
      cwd: repo,
      env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_MESSAGE: message },
    }).status === 0;

  git('init', '-q');
  const deployed = commit('client/src/main.tsx');

  test('skips commits that change only the docs, the tests, the CI and the scripts (K-36)', () => {
    for (const file of ['docs/roadmap.md', 'test/chat.test.ts', '.github/workflows/ci.yml', 'scripts/claim.sh', 'README.md']) {
      commit(file);
    }
    assert.equal(skips(deployed), true);
  });

  test('builds once the app changed since the last deployment', () => {
    commit('server/api.ts');
    assert.equal(skips(deployed), false);
  });

  test('builds when the last deployment is unknown or not in the clone', () => {
    assert.equal(skips(''), false);
    assert.equal(skips('0123456789abcdef0123456789abcdef01234567'), false);
  });

  test('skips a Release Please commit', () => {
    assert.equal(skips('', 'chore(main): Release 0.2.0'), true);
  });
});
