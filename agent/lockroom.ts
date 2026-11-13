// What setup builds for the locked room (docs/decisions/locked-room.md): a role account that holds
// the agent's keys, its folders, its root-owned program and the system service that runs it. Every
// command that runs as root is a `Cmd` made by a pure function here, and runs through one `Root`,
// which tests replace with a recorder. Root writes generated content through its stdin, into a
// folder only root can write, never through a file the owner could swap.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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
  /** The updater's LaunchDaemon, or its systemd service and timer; its log on macOS, where Linux uses the journal. */
  updaterLabel: string;
  updaterUnit: string;
  updaterTimer: string;
  updaterLog: string;
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
        updaterLabel: `com.webchat${suffix}.updater`,
        updaterUnit: `/Library/LaunchDaemons/com.webchat${suffix}.updater.plist`,
        updaterTimer: '',
        updaterLog: `/Library/Logs/WebChat${suffix}/updater.log`,
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
        updaterLabel: `webchat${suffix}-updater`,
        updaterUnit: `/etc/systemd/system/webchat${suffix}-updater.service`,
        updaterTimer: `/etc/systemd/system/webchat${suffix}-updater.timer`,
        updaterLog: '',
        git: '/usr/bin/git',
        rootUid: 0,
      };

export const programOf = (l: Layout) => path.join(l.programDir, 'webchat-agent');
export const ghOf = (l: Layout) => path.join(l.programDir, 'bin', 'gh');
export const socketOf = (l: Layout) => path.join(l.ipc, 'keyholder.sock');
/** What the updater reads (written by setup) and keeps, both in the root-owned folder. */
export const updateConfigOf = (l: Layout) => path.join(l.programDir, 'update.json');
export const stateOf = (l: Layout) => path.join(l.programDir, 'update-state.json');
export const stagedOf = (l: Layout, release: string) => path.join(l.programDir, '.staged', `webchat-agent-${release}`);
/** A release as the server and the release files name it: three numbers, nothing else, so no plan can carry more. */
export const RELEASE = /^\d+\.\d+\.\d+$/;
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

/** Runs commands as the process that owns them, with `wrap` saying what to execute. Output is captured unless the command shows it. */
const rootVia =
  (wrap: (cmd: Cmd) => string[]): Root =>
  (cmd) =>
    new Promise((resolve, reject) => {
      const tty = cmd.stdio === 'tty';
      const [file, ...args] = wrap(cmd);
      const child = spawn(file!, args, { stdio: [tty ? 'inherit' : 'pipe', cmd.stdio ? 'inherit' : 'pipe', cmd.stdio ? 'inherit' : 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => out.push(chunk)).on('error', () => undefined);
      child.stderr?.on('data', (chunk: Buffer) => err.push(chunk)).on('error', () => undefined);
      child.stdin?.on('error', () => undefined).end(cmd.stdin);
      child.on('error', reject).on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(`${cmd.argv[0]} failed with code ${code}. ${Buffer.concat(err).toString().trim()}`))));
    });

/** `sudo -n`: setup opened the password's cache before it. */
export const realRoot = rootVia((cmd) => ['sudo', '-n', ...(cmd.as ? ['-u', cmd.as] : []), ...(cmd.group ? ['-g', cmd.group] : []), '--', ...cmd.argv]);

/** The updater is root already, so it runs its commands itself: no sudo, and nothing as another account. */
export const selfRoot = rootVia((cmd) => {
  if (cmd.as) throw new Error('The updater runs nothing as another account.');
  return cmd.argv;
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

/** What the keyholder's service file says: the updater compares it with the file on disk after a release. */
export const unitText = (l: Layout, program: string) => (l.platform === 'darwin' ? keyholderPlist(l, program) : keyholderUnit(l, program));

/** Writes the service's file and starts it, replacing one that runs. */
export function servicePlan(l: Layout, program: string): Cmd[] {
  if (l.platform === 'darwin') return [put(l.unit, '644', unitText(l, program)), { argv: ['launchctl', 'bootout', `system/${l.label}`], soft: true }, { argv: ['launchctl', 'bootstrap', 'system', l.unit] }];
  return [put(l.unit, '644', unitText(l, program)), { argv: ['systemctl', 'daemon-reload'] }, { argv: ['systemctl', 'enable', l.label] }, { argv: ['systemctl', 'restart', l.label] }];
}

/** The updater's PATH: only folders root owns, as the keyholder's. */
const updaterPath = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Minutes between checks. A check is one small request, and a release is rare. */
const CHECK_MINUTES = 15;

/** The updater's LaunchDaemon: it runs as root, at load and every 15 minutes, which launchd also catches up after sleep. */
export const updaterPlist = (l: Layout, program: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(l.updaterLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>update</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${CHECK_MINUTES * 60}</integer>
  <key>Umask</key>
  <integer>18</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${updaterPath}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(l.updaterLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(l.updaterLog)}</string>
</dict>
</plist>
`;

/** The updater as a oneshot: root, but with the disk read-only except its own folder and the keyholder's unit, which a release may change. The timer starts it. */
export const updaterService = (l: Layout, program: string) => `[Unit]
Description=WebChat agent updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${quoted(program, true)} update
UMask=0022
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=${l.programDir} ${path.dirname(l.unit)}
PrivateTmp=yes
Environment=${quoted(`PATH=${updaterPath}`)}
`;

/** The timer: wall-clock quarter hours, which `Persistent` catches up after a suspend, a little apart across laptops. */
export const updaterTimerUnit = () => `[Unit]
Description=WebChat agent updater timer

[Timer]
OnBootSec=2min
OnCalendar=*:0/${CHECK_MINUTES}
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
`;

/** Installs the updater and starts it, replacing one that runs. `config` is what it reads of this laptop; left out, the one there stays. */
export function updaterPlan(l: Layout, program: string, config?: { server?: string; releases?: string; suffix?: string }): Cmd[] {
  const configure = config ? [put(updateConfigOf(l), '644', JSON.stringify(config))] : [];
  if (l.platform === 'darwin') return [...configure, put(l.updaterUnit, '644', updaterPlist(l, program)), ...stopUpdaterPlan(l), { argv: ['launchctl', 'bootstrap', 'system', l.updaterUnit] }];
  return [...configure, put(l.updaterUnit, '644', updaterService(l, program)), put(l.updaterTimer, '644', updaterTimerUnit()), { argv: ['systemctl', 'daemon-reload'] }, { argv: ['systemctl', 'enable', '--now', `${l.updaterLabel}.timer`] }];
}

/** Stops the updater, so it cannot swap the program under setup or restart the keyholder under uninstall. */
export const stopUpdaterPlan = (l: Layout): Cmd[] => [l.platform === 'darwin' ? { argv: ['launchctl', 'bootout', `system/${l.updaterLabel}`], soft: true } : { argv: ['systemctl', 'stop', `${l.updaterLabel}.timer`, `${l.updaterLabel}.service`], soft: true }];

/**
 * Stages a release's file, from the gzip bytes the updater already checked against the release's
 * checksum. It unzips into a folder of root's own and runs `--version` on the result before anything
 * moves, so a file that does not start never reaches the program's place. The release is an argument,
 * never part of the script.
 */
export function stagePlan(l: Layout, release: string, gz: Buffer): Cmd {
  assertRelease(release);
  return {
    argv: [
      'sh',
      '-c',
      'set -e; umask 022; mkdir -p "$1/.staged"; d=$(mktemp -d "$1/.staged/.in.XXXXXX"); trap \'rm -rf "$d"\' EXIT; cat > "$d/gz"; gunzip -c "$d/gz" > "$d/webchat-agent"; chmod 755 "$d/webchat-agent"; test "$("$d/webchat-agent" --version)" = "$2"; mv -f "$d/webchat-agent" "$1/.staged/webchat-agent-$2"',
      'sh',
      l.programDir,
      release,
    ],
    stdin: gz,
  };
}

/** The swap: the old program is kept under another name, and the new one takes its place by a rename, so no one ever sees half a file and a signed binary is never written over. */
export function swapPlan(l: Layout, release: string): Cmd[] {
  assertRelease(release);
  return [{ argv: ['sh', '-c', 'set -e; rm -f "$1/webchat-agent.previous"; ln "$1/webchat-agent" "$1/webchat-agent.previous"; mv -f "$1/.staged/webchat-agent-$2" "$1/webchat-agent"; rm -rf "$1/.staged"', 'sh', l.programDir, release] }];
}

/** The keyholder, started again from whatever the program's file is now. */
export const restartPlan = (l: Layout): Cmd[] => [l.platform === 'darwin' ? { argv: ['launchctl', 'kickstart', '-k', `system/${l.label}`] } : { argv: ['systemctl', 'restart', l.label] }];

/** Puts the kept program back, if the swap got as far as replacing it, drops the staged file of the release it skips, and restarts the keyholder. */
export const rollbackPlan = (l: Layout): Cmd[] => [{ argv: ['sh', '-c', 'p="$1/webchat-agent.previous"; [ ! -e "$p" ] || [ "$p" -ef "$1/webchat-agent" ] || mv -f "$p" "$1/webchat-agent"; rm -rf "$1/.staged"', 'sh', l.programDir] }, ...restartPlan(l)];

/** What a finished swap leaves: the kept program and any staged file. */
export const cleanupPlan = (l: Layout): Cmd[] => [{ argv: ['rm', '-rf', path.join(l.programDir, '.staged'), path.join(l.programDir, 'webchat-agent.previous')] }];

function assertRelease(release: string) {
  if (!RELEASE.test(release)) throw new Error(`${release} is not a release number.`);
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
  for (const p of [l.data, l.ipc, l.programDir, l.unit, l.updaterUnit, l.updaterTimer, ...(l.log ? [path.dirname(l.log)] : [])].filter(Boolean)) if (!path.isAbsolute(p) || p.split('/').filter(Boolean).length < 2 || p !== path.normalize(p)) throw new Error(`Refusing to remove ${p}.`);
}

/** Uninstall, in order. The account and groups go only when setup made them (`ours`). */
export function uninstallPlan(l: Layout, ours: boolean): Cmd[] {
  assertOwn(l);
  // The updater first, so it cannot kick the keyholder awake while it goes.
  const stop: Cmd[] =
    l.platform === 'darwin'
      ? [...stopUpdaterPlan(l), { argv: ['launchctl', 'bootout', `system/${l.label}`], soft: true }]
      : [{ argv: ['systemctl', 'disable', '--now', `${l.updaterLabel}.timer`], soft: true }, ...stopUpdaterPlan(l), { argv: ['systemctl', 'disable', '--now', l.label], soft: true }];
  const files: Cmd[] = [
    { argv: ['rm', '-f', l.unit, l.updaterUnit, ...(l.updaterTimer ? [l.updaterTimer] : [])] },
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

/**
 * Why the keyholder must not start, or undefined: it runs as the role account, its data folder is its
 * own with mode 700, and each program it runs belongs to root and is writable by no one else, up every
 * parent folder, since whoever can write there runs code as the keyholder (docs/decisions/locked-room.md).
 */
export async function selfProblem({ user, uid, data, programs, rootUid = 0, io = fs }: { user: string; uid: number; data: string; programs: string[]; rootUid?: number; io?: Pick<typeof fs, 'stat' | 'realpath'> }) {
  if (!user.startsWith('_webchat')) return `The keyholder runs as its role account only, and this is ${user}. Run \`webchat-agent setup\`.`;
  const own = await io.stat(data).catch(() => null);
  if (!own || own.uid !== uid || (own.mode & 0o777) !== 0o700) return `${data} is not the keyholder's own folder with mode 700.`;
  for (const program of programs) {
    const real = await io.realpath(program).catch(() => '');
    if (!real) return `${program} is missing.`;
    // The link's own folders too: whoever can write there can point it elsewhere.
    for (const start of new Set([program, real])) {
      for (let dir = start; ; dir = path.dirname(dir)) {
        const stat = await io.stat(dir);
        if (stat.uid !== rootUid || stat.mode & 0o022) return `${dir} is not owned by root alone, and ${program} runs as the keyholder.`;
        if (dir === path.dirname(dir)) break;
      }
    }
  }
}
