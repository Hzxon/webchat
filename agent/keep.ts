// What the agent's keys are for in git (docs/decisions/locked-room.md): the keyholder's own full bare
// clone of each repository, which fetches and pushes with `gh`'s login and nothing else, and takes a
// run's work only as a bundle it checks. It never runs git in a folder the owner owns and never
// checks anything out, so a link in a repository cannot lead a write to its own files.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** The largest bundle the keyholder takes: a run's commits, never a repository. */
export const MAX_BUNDLE = 512 * 1024 * 1024;
const ZERO = '0'.repeat(40);

/** A repository's folder in the agent's own, such as `repos/acme__app` (D-094). */
export const repoHome = (dataDir: string, repo: string) => path.join(dataDir, 'repos', repo.replace('/', '__'));

/** A file's SHA-256, which the one that made a bundle reports and the one that takes it checks. */
export const sha256 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });

export interface KeepOptions {
  /** The agent's own folder. */
  dataDir: string;
  /** The program that holds GitHub's login, which git asks for credentials. */
  gh?: string;
  /** The largest bundle it takes. */
  maxBundle?: number;
  /** Who its own commits, the board's copy, are by. */
  identity?: { name: string; email: string };
}

export class Keep {
  /** The last operation on each repository, which the next one waits for. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: KeepOptions) {}

  private dir(repo: string) {
    return path.join(repoHome(this.options.dataDir, repo), 'git');
  }

  /**
   * One git operation per repository at a time, so two fetches never fail one on a ref lock and a
   * push never meets a half-taken bundle.
   */
  private locked<T>(repo: string, work: () => Promise<T>) {
    const key = repo.toLowerCase();
    const next = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  /**
   * Git in the clone, with hooks off and the credentials only from `gh`: no other helper, and no
   * prompt. A repository's own files never run anything here, as nothing is checked out.
   */
  private async git(repo: string, args: string[], { input, env }: { input?: string; env?: NodeJS.ProcessEnv } = {}) {
    const helper = `!${this.options.gh ?? 'gh'} auth git-credential`;
    const run = exec('git', ['--git-dir', this.dir(repo), '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', `credential.https://github.com.helper=${helper}`, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    if (input !== undefined) run.child.stdin!.end(input);
    return (await run).stdout.trim();
  }

  private can(repo: string, args: string[]) {
    return this.git(repo, args).then(() => true, () => false);
  }

  /** Fetches origin into the clone, which it makes first when it has none; returns the default branch as `origin/main` and its commit. */
  fetch(repo: string) {
    return this.locked(repo, async () => {
      if (!existsSync(path.join(this.dir(repo), 'HEAD'))) {
        await fs.mkdir(this.dir(repo), { recursive: true, mode: 0o700 });
        // No template, which would bring hooks.
        await exec('git', ['init', '-q', '--bare', '--template=', this.dir(repo)]);
        await this.git(repo, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
      }
      await this.git(repo, ['fetch', '-q', 'origin']);
      const head = () => this.git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const ref = await head().catch(() => this.git(repo, ['remote', 'set-head', 'origin', '--auto']).then(head)).catch(() => 'origin/main');
      return { ref, tip: await this.git(repo, ['rev-parse', `refs/remotes/${ref}`]) };
    });
  }

  /** The names of the `agent/*` branches the clone knows, its own and origin's, which a new run must not take. */
  branches(repo: string) {
    return this.locked(repo, async () => {
      const refs = (await this.git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/agent', 'refs/remotes/origin/agent'])).split('\n').filter(Boolean);
      return [...new Set(refs.map((r) => r.replace(/^refs\/(heads|remotes\/origin)\//, '')))];
    });
  }

  /**
   * Writes `ref`, a default branch such as `origin/main`, as a bundle of one ref: only what comes
   * after `since`, when the clone has that commit and it makes a bundle, otherwise all of it.
   */
  baseBundle(repo: string, file: string, ref: string, since?: string) {
    return this.locked(repo, async () => {
      const create = (...exclude: string[]) => this.git(repo, ['bundle', 'create', '-q', file, `refs/remotes/${ref}`, ...exclude]);
      await (since ? create(`^${since}`).catch(() => create()) : create());
    });
  }

  /**
   * Takes the bundle a run made, only if it holds one ref, `refs/heads/<branch>`, the run's own
   * `agent/` branch; it passes git's own checks, fsck included; and its commits are the run's own,
   * on top of `since` and of what the clone has of the branch. Nothing moves otherwise. Returns the
   * branch's new head. `reported` is the size and SHA-256 the one that made it gave.
   */
  acceptBundle(repo: string, file: string, { branch, since, reported }: { branch: string; since: string; reported?: { bytes: number; sha256: string } }) {
    return this.locked(repo, async () => {
      const ref = `refs/heads/${branch}`;
      const { size } = await fs.stat(file);
      if (size > (this.options.maxBundle ?? MAX_BUNDLE)) throw new Error('The work is too large to push.');
      if (reported && (reported.bytes !== size || reported.sha256 !== (await sha256(file)))) throw new Error('The work changed on its way here.');
      if (!branch.startsWith('agent/') || !(await this.can(repo, ['check-ref-format', ref]))) throw new Error(`${branch} is no branch an agent may push.`);
      const heads = (await this.git(repo, ['bundle', 'list-heads', file])).split('\n').map((l) => l.split(' ')[1]);
      if (heads.length !== 1 || heads[0] !== ref) throw new Error(`The work holds more than ${ref}, or another branch than it.`);
      await this.git(repo, ['bundle', 'verify', '-q', file]);
      // Into a ref of its own first, so a bundle that fails a check below moves nothing. Forced, since a keyholder stopped mid-accept leaves the last one there.
      const incoming = 'refs/webchat/incoming';
      await this.git(repo, ['-c', 'transfer.fsckObjects=true', 'fetch', '-q', '--no-tags', file, `+${ref}:${incoming}`]);
      try {
        const head = await this.git(repo, ['rev-parse', incoming]);
        const old = await this.git(repo, ['rev-parse', '--verify', '-q', ref]).catch(() => '');
        if (!(await this.can(repo, ['merge-base', '--is-ancestor', since, head]))) throw new Error(`The work does not start from ${since}.`);
        // Never a rewind: what the branch had stays in it.
        if (old && !(await this.can(repo, ['merge-base', '--is-ancestor', old, head]))) throw new Error(`The work would drop commits of ${branch}.`);
        await this.git(repo, ['update-ref', ref, head, old || ZERO]);
        return head;
      } finally {
        await this.git(repo, ['update-ref', '-d', incoming]);
      }
    });
  }

  /** Pushes a branch the clone holds, never forced. */
  push(repo: string, branch: string) {
    return this.locked(repo, () => this.git(repo, ['push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]));
  }

  /** The files under `docs/` that a board's copy and its proposals use, on a commit, with their blobs (R-040). */
  docFiles(repo: string, commit: string) {
    return this.locked(repo, async () => {
      const out = await this.git(repo, ['ls-tree', '-r', commit, '--', 'docs/roadmap.md', 'docs/decisions.md', 'docs/roadmap', 'docs/decisions']);
      return out.split('\n').flatMap((line) => {
        const found = /^\d+ blob ([0-9a-f]+)\t(.+\.md)$/.exec(line);
        return found && !found[2]!.endsWith('/README.md') ? [{ path: found[2]!, blob: found[1]! }] : [];
      });
    });
  }

  /** A blob's text, as git holds it. */
  show(repo: string, blob: string) {
    return this.locked(repo, async () => (await exec('git', ['--git-dir', this.dir(repo), 'cat-file', '-p', blob], { maxBuffer: 32 * 1024 * 1024 })).stdout);
  }

  /**
   * Commits `files` and the removal of `remove` onto `branch`, on `base`'s tree, as origin has the
   * branch plus `base` merged in; undefined when that changes nothing. Made with git's plumbing in a
   * temporary index, with no checkout: a link in the repository, such as `docs`, cannot lead a write
   * out of the clone, and git refuses to put a file under it.
   */
  commitFiles(repo: string, { branch, base, files, remove, message }: { branch: string; base: string; files: Record<string, string>; remove: string[]; message: string }) {
    return this.locked(repo, async () => {
      const index = path.join(repoHome(this.options.dataDir, repo), 'index');
      const { name, email } = this.options.identity ?? { name: 'WebChat agent', email: 'agent@webchat.invalid' };
      const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
      try {
        await this.git(repo, ['read-tree', base], { env });
        for (const [file, text] of Object.entries(files)) {
          const blob = await this.git(repo, ['hash-object', '-w', '--stdin'], { input: text });
          await this.git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
        }
        // Mode 0 takes a path out of the index, which `--force-remove` does only with a work tree.
        if (remove.length) await this.git(repo, ['update-index', '--index-info'], { env, input: remove.map((file) => `0 ${ZERO}\t${file}\n`).join('') });
        const tree = await this.git(repo, ['write-tree'], { env });
        const remote = await this.git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).catch(() => '');
        const merged = !remote || (await this.can(repo, ['merge-base', '--is-ancestor', base, remote]));
        // A branch behind the default branch needs it merged in for a removal to show in the pull request.
        if (tree === (await this.git(repo, ['rev-parse', `${remote || base}^{tree}`])) && (merged || !remove.length)) return;
        const parents = remote ? (merged ? [remote] : [remote, base]) : [base];
        const commit = await this.git(repo, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { env });
        await this.git(repo, ['update-ref', `refs/heads/${branch}`, commit]);
        return commit;
      } finally {
        await fs.rm(index, { force: true });
      }
    });
  }

  /** How many commits `branch` has that `base` has not, as the clone has them; 0 for a branch it knows nothing of. */
  ahead(repo: string, base: string, branch: string) {
    return this.locked(repo, async () => {
      const tip = (await this.git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).catch(() => '')) || (await this.git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).catch(() => '')) || base;
      return Number(await this.git(repo, ['rev-list', '--count', `${base}..${tip}`]));
    });
  }
}
