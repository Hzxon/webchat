// What setup builds for the locked room (docs/decisions/locked-room.md): a role account that holds
// the agent's keys, its folders, its root-owned program and the system service that runs it. Every
// command that runs as root is a `Cmd` made by a pure function here, and runs through one `Root`,
// which tests replace with a recorder. Root writes generated content through its stdin, into a
// folder only root can write, never through a file the owner could swap.
import { spawn } from 'node:child_process';
import path from 'node:path';

/** What marks an account or group as setup's own, in its full name or comment: uninstall deletes only these. */
export const MARK = 'WebChat agent (made by webchat-agent setup)';

export interface Layout {
  platform: 'darwin' | 'linux';
  /** The role account, and the group only its owner is in, which may open the socket. */
  user: string;
  ipcGroup: string;
  /** The account's folder, mode 700, and the socket's, 2750. */
  data: string;
  ipc: string;
  /** The root-owned folder with the program and `bin/gh`. */
  programDir: string;
  /** The keyholder's LaunchDaemon file or systemd unit, and the service's name. */
  unit: string;
  label: string;
  /** The keyholder's log, which launchd needs made for it; Linux logs to the journal. */
  log: string;
  /** The only git the keyholder runs. */
  git: string;
  /** Who must own the program, git and gh: root, unless a test says otherwise. */
  rootUid: number;
}

/** The names and places for a system; a `suffix` such as `test` makes a layout that touches none of the real ones. */
export const layoutFor = (platform: 'darwin' | 'linux', suffix = ''): Layout =>
  platform === 'darwin'
    ? {
        platform,
        user: `_webchat${suffix}`,
        ipcGroup: `_webchat${suffix}ipc`,
        data: `/var/webchat${suffix}`,
        ipc: `/var/webchat${suffix}-ipc`,
        programDir: `/Library/WebChat${suffix}`,
        unit: `/Library/LaunchDaemons/com.webchat${suffix}.keyholder.plist`,
        label: `com.webchat${suffix}.keyholder`,
        log: `/Library/Logs/WebChat${suffix}/keyholder.log`,
        git: '/Library/Developer/CommandLineTools/usr/bin/git',
        rootUid: 0,
      }
    : {
        platform,
        user: `_webchat${suffix}`,
        ipcGroup: `_webchat${suffix}ipc`,
        data: `/var/lib/webchat${suffix}`,
        ipc: `/var/webchat${suffix}-ipc`,
        programDir: `/opt/webchat${suffix}`,
        unit: `/etc/systemd/system/webchat${suffix}-keyholder.service`,
        label: `webchat${suffix}-keyholder`,
        log: '',
        git: '/usr/bin/git',
        rootUid: 0,
      };

export const programOf = (l: Layout) => path.join(l.programDir, 'webchat-agent');
export const ghOf = (l: Layout) => path.join(l.programDir, 'bin', 'gh');
export const socketOf = (l: Layout) => path.join(l.ipc, 'keyholder.sock');
const rootGroup = (l: Layout) => (l.platform === 'darwin' ? 'wheel' : 'root');

/** One command for root, or for the role account with `as`. `stdin` is how content reaches it; a code never goes in `argv`. */
export interface Cmd {
  argv: string[];
  as?: string;
  /** With `as`, the group it runs in, so the owner's session need not have joined it yet. */
  group?: string;
  stdin?: string | Buffer;
  /** Shows its output on the terminal, or with `tty` also reads the terminal. */
  stdio?: 'show' | 'tty';
  /** A failure is fine: the thing may not be there. */
  soft?: true;
}
export type Root = (cmd: Cmd) => Promise<string>;

/** Runs each command, and stops at the first that fails unless it is soft. */
export async function runAll(root: Root, cmds: Cmd[]) {
  for (const cmd of cmds) await root(cmd).catch((error: unknown) => (cmd.soft ? undefined : Promise.reject(error)));
}

/** `sudo -n`: setup opened the password's cache before it. Output is captured unless the command shows it. */
export const realRoot: Root = (cmd) =>
  new Promise((resolve, reject) => {
    const tty = cmd.stdio === 'tty';
    const child = spawn('sudo', ['-n', ...(cmd.as ? ['-u', cmd.as] : []), ...(cmd.group ? ['-g', cmd.group] : []), '--', ...cmd.argv], { stdio: [tty ? 'inherit' : 'pipe', cmd.stdio ? 'inherit' : 'pipe', cmd.stdio ? 'inherit' : 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk)).on('error', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk)).on('error', () => undefined);
    child.stdin?.on('error', () => undefined).end(cmd.stdin);
    child.on('error', reject).on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(`${cmd.argv[0]} failed with code ${code}. ${Buffer.concat(err).toString().trim()}`))));
  });

/** Writes `stdin` to `dst` by way of a sibling and a rename, so a running program is never written to. */
export const put = (dst: string, mode: '644' | '755', stdin: string | Buffer): Cmd => ({ argv: ['sh', '-c', `set -e; umask 022; cat > "$1.new"; chmod ${mode} "$1.new"; mv -f "$1.new" "$1"`, 'sh', dst], stdin });
/** Writes a file into the role account's folder, as that account, readable by it alone. */
export const putAs = (l: Layout, dst: string, stdin: string | Buffer): Cmd => ({ argv: ['sh', '-c', 'set -e; umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"', 'sh', dst], as: l.user, stdin });

/** The program's PATH: only folders that root owns, so nothing the owner can write runs as the keyholder. */
export const keyholderPath = (l: Layout) => [...new Set([path.join(l.programDir, 'bin'), path.dirname(l.git), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');

export const keyholderEnv = (l: Layout): Record<string, string> => ({
  HOME: l.data,
  WEBCHAT_AGENT_HOME: l.data,
  WEBCHAT_SOCKET: socketOf(l),
  GH_CONFIG_DIR: path.join(l.data, 'gh'),
  PATH: keyholderPath(l),
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** `env -i` with these variables, so a command as the role account gets nothing of the owner's. */
const cleanEnv = (env: Record<string, string>) => ['env', '-i', ...Object.entries(env).map(([name, value]) => `${name}=${value}`)];

export const xml = (text: string) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** A value in double quotes for a unit file: `\`, `"` and the specifier `%` escaped, and `$` too on a line that expands variables. */
export const quoted = (value: string, variables = false) => {
  const escaped = value.replace(/[\\"]/g, '\\$&').replaceAll('%', '%%');
  return `"${variables ? escaped.replaceAll('$', () => '$$') : escaped}"`;
};

/** The LaunchDaemon: it runs as the role account from boot, and again whenever the keyholder exits. */
export const keyholderPlist = (l: Layout, program: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(l.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>keyholder</string>
  </array>
  <key>UserName</key>
  <string>${xml(l.user)}</string>
  <key>GroupName</key>
  <string>${xml(l.user)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(keyholderEnv(l))
  .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(l.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(l.log)}</string>
</dict>
</plist>
`;

/** The system unit. The sandbox lines keep the owner's folders out of its sight, which is the point of the room. */
export const keyholderUnit = (l: Layout, program: string) => `[Unit]
Description=WebChat agent keyholder
After=network-online.target
Wants=network-online.target

[Service]
User=${l.user}
Group=${l.user}
ExecStart=${quoted(program, true)} keyholder
StateDirectory=${path.basename(l.data)}
StateDirectoryMode=0700
UMask=0077
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=${l.data} ${l.ipc}
PrivateTmp=yes
NoNewPrivileges=yes
${Object.entries(keyholderEnv(l))
  .map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`)
  .join('\n')}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;

/** The ids from `dscl . -list <kind> <key>`: the last word of each line. */
export const idsOf = (listing: string) => listing.split('\n').flatMap((line) => /\s(-?\d+)\s*$/.exec(line)?.[1] ?? []).map(Number);

/** `count` ids in 450-499, the range for role accounts, that nothing uses. */
export function freeIds(taken: number[], count: number) {
  const free = Array.from({ length: 50 }, (_, i) => 450 + i).filter((id) => !taken.includes(id));
  if (free.length < count) throw new Error('Every id from 450 to 499 is in use, so setup cannot make a role account. Nothing was changed.');
  return free.slice(0, count);
}

export type Own = 'none' | 'ours' | 'foreign';
export interface Found {
  user: Own;
  /** The account's own group, which macOS makes by hand and Linux makes with the account. */
  group: Own;
  ipc: Own;
  members: string[];
}
/** Runs a read-only command and returns its output, or undefined when it fails. */
export type Read = (argv: string[]) => Promise<string | undefined>;

/** Which of the account and the groups exist, whether setup made them, and who is in the ipc group. */
export async function inspectRoom(l: Layout, read: Read): Promise<Found> {
  if (l.platform === 'darwin') {
    const own = async (kind: string, name: string): Promise<Own> => {
      const text = await read(['dscl', '.', '-read', `/${kind}/${name}`, 'RealName']);
      return text === undefined ? 'none' : text.includes(MARK) ? 'ours' : 'foreign';
    };
    const members = (await read(['dscl', '.', '-read', `/Groups/${l.ipcGroup}`, 'GroupMembership'])) ?? '';
    return { user: await own('Users', l.user), group: await own('Groups', l.user), ipc: await own('Groups', l.ipcGroup), members: members.replace(/^GroupMembership:/, '').trim().split(/\s+/).filter(Boolean) };
  }
  // Linux keeps a mark only on the account, so its groups are ours when it is.
  const [passwd, group, ipc] = await Promise.all([l.user, l.user, l.ipcGroup].map((name, i) => read(['getent', i ? 'group' : 'passwd', name])));
  const user: Own = passwd === undefined ? 'none' : passwd.split(':')[4]?.includes(MARK) ? 'ours' : 'foreign';
  const of = (line: string | undefined): Own => (line === undefined ? 'none' : user === 'ours' ? 'ours' : 'foreign');
  return { user, group: of(group), ipc: of(ipc), members: ipc?.trim().split(':')[3]?.split(',').filter(Boolean) ?? [] };
}

/** Why setup must not go on, as words for the owner. Empty when it may. */
export function refusals(l: Layout, owner: string, found: Found) {
  const out: string[] = [];
  if ([found.user, found.group, found.ipc].includes('foreign')) out.push(`An account or group named ${l.user} or ${l.ipcGroup} exists that setup did not make, so setup leaves it alone. Remove it yourself or ask whoever made it.`);
  const others = found.members.filter((member) => member !== owner);
  if (others.length) out.push(`${l.ipcGroup} already holds ${others.join(', ')}. The agent has one owner per laptop: whoever is in that group can use it.`);
  return out;
}

/** The account, the groups and the owner's place in the ipc group. Idempotent: it makes only what is missing. */
export function createPlan(l: Layout, owner: string, found: Found, ids: number[]): Cmd[] {
  const [first = 0, second = 0] = ids;
  if (l.platform === 'darwin') {
    const group = (name: string, id: number): Cmd => ({ argv: ['dseditgroup', '-o', 'create', '-i', String(id), '-r', MARK, name] });
    const fresh = found.user === 'none';
    // A role account takes its group's id, so an account half made has no id to go on: start it over.
    const cmds: Cmd[] = [...(fresh && found.group === 'ours' ? [{ argv: ['dseditgroup', '-o', 'delete', l.user], soft: true } satisfies Cmd] : [])];
    if (found.ipc === 'none') cmds.push(group(l.ipcGroup, second));
    if (fresh) {
      cmds.push(group(l.user, first));
      cmds.push({ argv: ['sysadminctl', '-addUser', l.user, '-fullName', MARK, '-UID', String(first), '-GID', String(first), '-shell', '/usr/bin/false', '-roleAccount'] });
      cmds.push({ argv: ['dscl', '.', 'create', `/Users/${l.user}`, 'IsHidden', '1'] });
    }
    if (!found.members.includes(owner)) cmds.push({ argv: ['dseditgroup', '-o', 'edit', '-a', owner, '-t', 'user', l.ipcGroup] });
    return cmds;
  }
  return [
    ...(found.user === 'none' ? [{ argv: ['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', l.data, '--shell', '/usr/sbin/nologin', '--comment', MARK, l.user] }] : []),
    ...(found.ipc === 'none' ? [{ argv: ['groupadd', '--system', l.ipcGroup] }] : []),
    ...(found.members.includes(owner) ? [] : [{ argv: ['usermod', '-aG', l.ipcGroup, owner] }]),
  ];
}

/** The folders: only the account reads its own; only its owner and it reach the socket; root owns what runs. */
export function foldersPlan(l: Layout): Cmd[] {
  const dirs: Cmd[] = [
    { argv: ['install', '-d', '-o', l.user, '-g', l.user, '-m', '700', l.data] },
    { argv: ['install', '-d', '-o', l.user, '-g', l.ipcGroup, '-m', '2750', l.ipc] },
    // Some `install` drop the setgid bit, which gives the socket the group.
    { argv: ['chmod', '2750', l.ipc] },
    { argv: ['install', '-d', '-o', 'root', '-g', rootGroup(l), '-m', '755', l.programDir, path.join(l.programDir, 'bin')] },
  ];
  if (!l.log) return dirs;
  return [
    ...dirs,
    { argv: ['install', '-d', '-o', 'root', '-g', rootGroup(l), '-m', '755', path.dirname(l.log)] },
    // launchd opens the log as the account, and cannot make it in a folder only root writes.
    { argv: ['touch', l.log] },
    { argv: ['chown', `${l.user}:${l.ipcGroup}`, l.log] },
    { argv: ['chmod', '640', l.log] },
  ];
}

/** The program, from bytes setup already checked against its own hash. */
export const programPlan = (l: Layout, bytes: Buffer) => [put(programOf(l), '755', bytes)];

/**
 * Installs `gh` from a release archive, which setup checked against its pinned sum. The archive goes
 * into a folder of root's own, and only `bin/gh` comes out of it.
 */
export const ghPlan = (l: Layout, archive: Buffer): Cmd => ({
  argv: [
    'sh',
    '-c',
    'set -e; umask 022; d=$(mktemp -d "$1/.gh.XXXXXX"); trap \'rm -rf "$d"\' EXIT; cat > "$d/archive"; tar -xof "$d/archive" -C "$d"; install -m 755 -o root -g "$2" "$d"/*/bin/gh "$1/bin/gh"',
    'sh',
    l.programDir,
    rootGroup(l),
  ],
  stdin: archive,
});

/** Writes the service's file and starts it, replacing one that runs. */
export function servicePlan(l: Layout, program: string): Cmd[] {
  if (l.platform === 'darwin') return [put(l.unit, '644', keyholderPlist(l, program)), { argv: ['launchctl', 'bootout', `system/${l.label}`], soft: true }, { argv: ['launchctl', 'bootstrap', 'system', l.unit] }];
  return [put(l.unit, '644', keyholderUnit(l, program)), { argv: ['systemctl', 'daemon-reload'] }, { argv: ['systemctl', 'enable', l.label] }, { argv: ['systemctl', 'restart', l.label] }];
}

/** What the account's own `gh` runs with: the keyholder's variables, and what a sign-in needs to print its code and open no browser. */
const ghAs = (l: Layout, args: string[], env: Record<string, string> = keyholderEnv(l)): Cmd => ({ argv: [...cleanEnv(env), ghOf(l), ...args], as: l.user });

export const signedInPlan = (l: Layout): Cmd => ghAs(l, ['auth', 'status', '--hostname', 'github.com']);
/** The device sign-in: default scopes only, no `workflow`, and the token in a file of its folder, not a keychain. */
export const loginPlan = (l: Layout): Cmd => {
  const { GH_PROMPT_DISABLED: _off, ...env } = keyholderEnv(l);
  return { ...ghAs(l, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage', '--skip-ssh-key'], { ...env, GH_BROWSER: '/usr/bin/true', TERM: process.env.TERM || 'dumb' }), stdio: 'tty' };
};

/** Pairs as the role account. The code and the picks go on stdin, so no process list shows the code. */
export const pairPlan = (l: Layout, input: { code: string; picks?: unknown }): Cmd => ({ argv: [...cleanEnv(keyholderEnv(l)), programOf(l), 'pair'], as: l.user, stdin: JSON.stringify(input), stdio: 'show' });

/** The paths uninstall removes with `rm -rf` must be a folder of their own, never a system one. */
function assertOwn(l: Layout) {
  for (const p of [l.data, l.ipc, l.programDir, l.unit, ...(l.log ? [path.dirname(l.log)] : [])]) if (!path.isAbsolute(p) || p.split('/').filter(Boolean).length < 2 || p !== path.normalize(p)) throw new Error(`Refusing to remove ${p}.`);
}

/** Uninstall, in order. The account and groups go only when setup made them (`ours`). */
export function uninstallPlan(l: Layout, ours: boolean): Cmd[] {
  assertOwn(l);
  const stop: Cmd[] = l.platform === 'darwin' ? [{ argv: ['launchctl', 'bootout', `system/${l.label}`], soft: true }] : [{ argv: ['systemctl', 'disable', '--now', l.label], soft: true }];
  const files: Cmd[] = [
    { argv: ['rm', '-f', l.unit] },
    ...(l.platform === 'linux' ? [{ argv: ['systemctl', 'daemon-reload'], soft: true } satisfies Cmd] : []),
    // Logs the account out of GitHub here only: the token stays valid there until the owner revokes it.
    { ...ghAs(l, ['auth', 'logout', '--hostname', 'github.com']), soft: true },
    { argv: ['pkill', '-KILL', '-u', l.user], soft: true },
    { argv: ['rm', '-rf', l.data, l.ipc, l.programDir, ...(l.log ? [path.dirname(l.log)] : [])] },
  ];
  if (!ours) return [...stop, ...files];
  const gone: Cmd[] =
    l.platform === 'darwin'
      ? [{ argv: ['sysadminctl', '-deleteUser', l.user, '-secure'], soft: true }, { argv: ['dscl', '.', '-delete', `/Users/${l.user}`], soft: true }, { argv: ['dseditgroup', '-o', 'delete', l.ipcGroup], soft: true }, { argv: ['dseditgroup', '-o', 'delete', l.user], soft: true }]
      : [{ argv: ['userdel', l.user], soft: true }, { argv: ['groupdel', l.ipcGroup], soft: true }, { argv: ['groupdel', l.user], soft: true }];
  // Deleting a role account leaves its home, /var/empty, alone, so the folder goes by hand, once more in case it came back.
  return [...stop, ...files, ...gone, { argv: ['rm', '-rf', l.data] }];
}
