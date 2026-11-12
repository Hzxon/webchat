// Stands in for root and for the system's account lists, so setup's commands run against a temporary
// folder on any machine (docs/decisions/locked-room.md). It writes what setup writes through stdin,
// answers the few reads setup makes, and records every command that would have run as root.
import fs from 'node:fs/promises';
import path from 'node:path';
import { layoutFor, MARK, type Cmd, type Layout, type Read, type Root } from '../agent/lockroom.ts';

/** A layout of names and folders that touch nothing real. `git` is a file the test made, owned by the test's user. */
export const testLayout = (dir: string, git = path.join(dir, 'git')): Layout => ({
  ...layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux', 'test'),
  data: path.join(dir, 'data'),
  ipc: path.join(dir, 'ipc'),
  programDir: path.join(dir, 'program'),
  unit: path.join(dir, 'keyholder.unit'),
  log: process.platform === 'darwin' ? path.join(dir, 'logs', 'keyholder.log') : '',
  git,
  rootUid: process.getuid!(),
});

export interface Fake {
  root: Root;
  read: Read;
  /** Every command, in order, as it would have run. */
  log: Cmd[];
  /** What the system's lists say now, which a test changes. */
  system: { made: boolean; members: string[]; foreign?: boolean };
  /** Whether `gh auth status` succeeds as the role account. */
  signedIn: boolean;
  /** What the owner's `status` prints, which says whether the keyholder took the account. */
  status: string;
  /** Pairs, as the role account would, from what setup put on stdin. */
  onPair?: (input: { code: string; picks?: unknown }) => Promise<void>;
}

export function fakeRoom(layout: Layout): Fake {
  const fake: Fake = {
    log: [],
    system: { made: false, members: [] },
    signedIn: true,
    status: 'Runner: connected\nTaking the cards that Alice hands to this agent, on http://x.\n',
    root: async (cmd) => {
      fake.log.push(cmd);
      const { argv, stdin } = cmd;
      const text = argv.join(' ');
      if (argv[0] === 'sh' && stdin !== undefined) {
        // Everything setup writes ends in its destination; the program's gh comes out of an archive.
        const dst = argv[2]!.includes('mktemp') ? path.join(argv[4]!, 'bin', 'gh') : argv.at(-1)!;
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.writeFile(dst, stdin);
        // The program is executable, and made by root.
        await fs.chmod(dst, 0o755);
      } else if (argv[0] === 'test') await fs.access(argv[2]!);
      else if (argv.at(-1) === 'pair') await fake.onPair?.(JSON.parse(String(stdin)));
      else if (text.includes('auth status') && !fake.signedIn) throw new Error('not signed in');
      else if (argv.at(-1) === 'status') return fake.status;
      else if (argv[0] === 'rm') for (const file of argv.slice(2)) await fs.rm(file, { recursive: true, force: true });
      else if (argv[0] === 'userdel' || argv[1] === '-deleteUser') fake.system.made = false;
      else if ((argv[0] === 'dseditgroup' && argv[2] === 'create') || argv[0] === 'useradd') fake.system.made = true;
      return '';
    },
    read: async (argv) => {
      const { made, members, foreign } = fake.system;
      const mark = foreign ? 'someone else' : MARK;
      if (argv[0] === 'dscl' && argv[2] === '-list') return '';
      if (argv[0] === 'dscl') return argv[3]!.endsWith(layout.ipcGroup) && argv[4] === 'GroupMembership' ? `GroupMembership: ${members.join(' ')}` : made ? `RealName:\n ${mark}` : undefined;
      if (argv[0] === 'getent') return made ? (argv[1] === 'passwd' ? `${layout.user}:x:999:999:${mark}:${layout.data}:/usr/sbin/nologin` : `${argv[2]}:x:998:${members.join(',')}`) : undefined;
      return undefined;
    },
  };
  return fake;
}
