// Two claims of one item seconds apart: the remote's tag refuses the second (docs/roadmap/new-atomic-claim.md).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Keep } from '../agent/keep.ts';

const sh = promisify(execFile);
const SCRIPT = path.resolve('scripts/claim.sh');
const GIT = ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com'];

/** A `gh` that lists no pull request until both claims have asked, as when GitHub has not indexed either draft yet. */
const FAKE_GH = `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  : > "$FAKE_GH_DIR/listed-$$"
  n=0
  while [ "$(ls "$FAKE_GH_DIR" | grep -c '^listed-')" -lt 2 ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
  : # the script's --jq filter prints nothing for no pull request
elif [ "$1 $2" = "pr create" ]; then
  echo "https://github.com/acme/app/pull/1"
fi
`;

describe('claiming an item that another claim takes at the same time', () => {
  let root: string;
  let origin: string;
  let global: string | undefined;
  const git = (dir: string, ...args: string[]) => sh('git', ['-C', dir, ...GIT, ...args]).then((r) => r.stdout.trim());

  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-claim-')));
    origin = path.join(root, 'origin.git');
    global = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
    await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, `[url "${origin}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
    await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = path.join(root, 'seed');
    await sh('git', ['clone', '-q', origin, seed]);
    await fs.mkdir(path.join(seed, 'docs/roadmap'), { recursive: true });
    await fs.writeFile(path.join(seed, 'docs/roadmap/K-12.md'), '### K-12: Sums are off\n\nStatus: Open.\n');
    await fs.writeFile(path.join(seed, 'docs/roadmap.md'), '');
    await fs.writeFile(path.join(seed, 'docs/decisions.md'), '');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-q', '-m', 'Start');
    await git(seed, 'push', '-q', 'origin', 'main');
    await fs.mkdir(path.join(root, 'bin'));
    await fs.writeFile(path.join(root, 'bin/gh'), FAKE_GH, { mode: 0o755 });
    await fs.mkdir(path.join(root, 'listed'));
  });
  after(async () => {
    if (global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = global;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('of two runs of scripts/claim.sh, exactly one gets it, and the other names the first', async () => {
    const claim = async (name: string) => {
      const dir = path.join(root, name);
      await sh('git', ['clone', '-q', origin, dir]);
      await git(dir, 'switch', '-q', '-c', `claude/k12-${name}`);
      const child = spawn('sh', [SCRIPT, '-c', 'Read K-12 on main.', '-t', 'a.ts', 'K-12', `fix: Claim ${name}`], {
        cwd: dir,
        env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, FAKE_GH_DIR: path.join(root, 'listed') },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const status = await new Promise<number | null>((done) => child.on('close', done));
      return { status, stderr };
    };
    const [a, b] = await Promise.all([claim('a'), claim('b')]);
    assert.deepEqual([a.status, b.status].sort(), [0, 1], `${a.stderr}\n${b.stderr}`);
    const [won, lost, winner] = a.status === 0 ? [a, b, 'a'] : [b, a, 'b'];
    assert.match(lost.stderr, new RegExp(`K-12 is already claimed: Claim K-12 for claude/k12-${winner}`), won.stderr);
    assert.equal(await sh('git', ['--git-dir', origin, 'tag', '-l', 'claim/*']).then((r) => r.stdout.trim()), 'claim/K-12');
  });

  test("of two agents' claims of one card, exactly one gets it, and the other names the first", async () => {
    const tip = await sh('git', ['--git-dir', origin, 'rev-parse', 'main']).then((r) => r.stdout.trim());
    const claim = (name: string) => new Keep({ dataDir: path.join(root, `data-${name}`) }).claim('acme/app', 'K-7', `agent/k-7-${name}`, tip);
    // Each laptop has its own clone, so each needs the commit first.
    await Promise.all(['a', 'b'].map((name) => new Keep({ dataDir: path.join(root, `data-${name}`) }).fetch('acme/app')));
    const results = await Promise.allSettled([claim('a'), claim('b')]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    const winner = results[0]!.status === 'fulfilled' ? 'a' : 'b';
    assert.match(String(lost.reason), new RegExp(`K-7 is already claimed: Claim K-7 for agent/k-7-${winner}`));
    // The tag goes when the claim does, which frees the card.
    await new Keep({ dataDir: path.join(root, `data-${winner}`) }).release('acme/app', 'K-7');
    assert.equal(await sh('git', ['--git-dir', origin, 'tag', '-l', 'claim/K-7']).then((r) => r.stdout.trim()), '');
    await claim('b');
  });
});
