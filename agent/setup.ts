// The daemon's setup commands (docs/roadmap/new-agent-setup.md, docs/decisions/agent-install.md).
// `setup` checks the laptop read-only, asks once, then builds the locked room (docs/decisions/locked-room.md,
// agent/lockroom.ts): the role account, the root-owned program, the keyholder service that runs as it
// and a login service for the runner. `doctor` repeats the checks, `status` says what runs, and
// `uninstall` takes it all away. Nothing here changes a security setting: where one blocks the
// agent, it prints the fix.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { HARNESS_ROW_WORDS, harnessRow, type ConfigDTO, type HarnessState, type PairingPick, type SetupChoice } from '../shared/types.ts';
import { Api } from './api.ts';
import { onPath } from './claude.ts';
import { AgentClient, readPairing, type AccountFile } from './client.ts';
import { GH_VERSION, ghArchive, ghAsset } from './gh.ts';
import { harnessFinder, SUPPORTED, supported } from './harnesses.ts';
import { sha256 } from './keep.ts';
import {
  createPlan, foldersPlan, freeIds, ghOf, ghPlan, idsOf, inspectRoom, layoutFor, loginPlan, pairPlan, programOf, programPlan, quoted, realRoot, refusals, runAll, servicePlan, signedInPlan, socketOf, uninstallPlan, xml,
  type Layout, type Read, type Root,
} from './lockroom.ts';
import { finishMove, moveAccount, newest, sources } from './move.ts';
import { callRoom, type RoomStatus } from './room.ts';
import { messageOf } from './runs.ts';

const exec = promisify(execFile);
/** The service's name on both systems: webchat-agent.plist, webchat-agent.service. */
const NAME = 'webchat-agent';
/** Claude Code's own installer, which puts `claude` in ~/.local/bin. */
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
/** Codex's own installer, from https://learn.chatgpt.com/docs/codex/cli. */
const CODEX_INSTALL = 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';
const GIB = 2 ** 30;

/** One line of the summary. `needs` names what setup would install for a `todo`. */
interface Row {
  level: 'ok' | 'warn' | 'todo' | 'fail';
  text: string;
  fix?: string;
  needs?: 'git' | 'bubblewrap' | 'socat' | 'claude' | 'codex';
}
const ok = (text: string): Row => ({ level: 'ok', text });
const run = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 30_000 }).then((r) => r.stdout);
const works = (cmd: string, args: string[]) => run(cmd, args).then(() => true, () => false);

/** Whether the groups `id -Gn` names make an account an administrator: `admin` on macOS, `sudo`, `wheel` or `admin` on Linux. */
export const isAdmin = (groups: string, platform: NodeJS.Platform) =>
  groups.split(/\s+/).some((group) => (platform === 'darwin' ? group === 'admin' : ['sudo', 'wheel', 'admin'].includes(group)));

const MARK = '__webchat_path__';

/** The PATH an interactive login shell printed between two markers, which keep what a profile echoes out of it. Empty when they are missing. */
export function pathFrom(output: string) {
  const parts = output.split(MARK);
  return parts.length === 3 ? parts[1]! : '';
}

/** The service's PATH: the login shell's, then the folder the installers use, which a profile may not list until a new login. */
export const servicePath = (login: string, home: string) => [...new Set([...login.split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin')])].join(path.delimiter);

/** What a terminal has on its PATH is not what a service gets, so ask the shell the way a login does. */
async function loginPath() {
  const shell = process.env.SHELL || '/bin/sh';
  const printed = await exec(shell, ['-ilc', `printf '%s%s%s' ${MARK} "$PATH" ${MARK}`], { timeout: 10_000 }).then((r) => r.stdout, () => '');
  return pathFrom(printed) || process.env.PATH || '';
}

/** The LaunchAgent: it starts at login and again whenever the runner exits. */
export const launchdPlist = (program: string, pathEnv: string, log: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>runner</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;

/** The `systemd --user` unit. RestartSec keeps a runner that fails at once from hitting systemd's start limit. */
export const systemdUnit = (program: string, pathEnv: string) => `[Unit]
Description=WebChat agent
After=network-online.target

[Service]
ExecStart=${quoted(program, true)} runner
Environment=${quoted(`PATH=${pathEnv}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

const mac = () => process.platform === 'darwin';
const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${NAME}.plist`);
const unitFile = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', `${NAME}.service`);
const domain = () => `gui/${process.getuid!()}`;
const accountFile = (home: string) => path.join(home, 'laptop', 'account.json');
const readAccount = (home: string) => fs.readFile(accountFile(home), 'utf8').then((text) => JSON.parse(text) as AccountFile, () => null);

/** Installs the service, or replaces the one there, and starts it. */
async function installService(program: string, pathEnv: string, home: string) {
  if (mac()) {
    const file = plistFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, launchdPlist(program, pathEnv, path.join(home, 'agent.log')));
    await run('launchctl', ['bootout', `${domain()}/${NAME}`]).catch(() => undefined);
    await run('launchctl', ['bootstrap', domain(), file]);
    return;
  }
  const file = unitFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, systemdUnit(program, pathEnv));
  for (const args of [['daemon-reload'], ['enable', NAME], ['restart', NAME]]) await run('systemctl', ['--user', ...args]);
}

async function removeService() {
  if (mac()) {
    await run('launchctl', ['bootout', `${domain()}/${NAME}`]).catch(() => undefined);
    await fs.rm(plistFile(), { force: true });
    return;
  }
  await run('systemctl', ['--user', 'disable', '--now', NAME]).catch(() => undefined);
  await fs.rm(unitFile(), { force: true });
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
}

async function serviceState(): Promise<'running' | 'stopped' | 'missing'> {
  if (!existsSync(mac() ? plistFile() : unitFile())) return 'missing';
  const said = mac() ? await run('launchctl', ['print', `${domain()}/${NAME}`]).catch(() => '') : await run('systemctl', ['--user', 'is-active', NAME]).catch(() => '');
  return (mac() ? /state = running/.test(said) : said.trim() === 'active') ? 'running' : 'stopped';
}

const adminRow = async (): Promise<Row> =>
  isAdmin(await run('id', ['-Gn']).catch(() => ''), process.platform)
    ? ok('Administrator: this account can install software')
    : {
        level: 'fail',
        text: 'Administrator: this account is not one.',
        fix: 'The agent installs software, and later keeps its keys under an account of its own, so it needs an administrator.\nAsk whoever set up this laptop to make you one, or use another laptop.',
      };

async function systemRow(): Promise<Row> {
  const name = mac()
    ? `macOS ${(await run('sw_vers', ['-productVersion']).catch(() => '')).trim()}`
    : /^PRETTY_NAME="?([^"\n]*)/m.exec(await fs.readFile('/etc/os-release', 'utf8').catch(() => ''))?.[1] || 'Linux';
  return ok(`System: ${name} on ${os.arch()}`);
}

/** The login service needs launchd, or `systemd --user`; WSL2 starts without systemd unless its owner turns it on. */
async function serviceRow(): Promise<Row> {
  if (mac()) return ok('Login service: launchd');
  if (await works('systemctl', ['--user', 'show-environment'])) return ok('Login service: systemd --user');
  const wsl = /microsoft/i.test(await fs.readFile('/proc/version', 'utf8').catch(() => ''));
  return {
    level: 'fail',
    text: `Login service: systemd --user does not run${wsl ? ' in this WSL2 distribution' : ' here'}.`,
    fix: wsl
      ? 'Add these lines to /etc/wsl.conf (setup changes nothing there):\n  [boot]\n  systemd=true\nThen run `wsl --shutdown` in Windows, open Ubuntu again and run the line again.'
      : 'The agent needs systemd to start at login and to start again after a failure.',
  };
}

/** The keyholder runs only git that root owns: Apple's command line tools, or /usr/bin/git. Homebrew's is the owner's to change. */
async function gitRow(packager: string, layout: Layout): Promise<Row> {
  if (await rootOwned(layout.git, layout)) return ok(`git: ${layout.git}`);
  return mac() || packager ? { level: 'todo', text: `git: not installed at ${layout.git}, where the agent needs a root-owned one.`, needs: 'git' } : { level: 'fail', text: 'git: not installed, and there is neither apt-get nor dnf to install it. Install it yourself.' };
}

/** Claude Code's sandbox on Linux needs bubblewrap and socat, and Ubuntu may forbid the user namespaces bubblewrap uses. */
async function sandboxRows(packager: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [tool, needs] of [['bwrap', 'bubblewrap'], ['socat', 'socat']] as const) {
    if (await onPath(tool)) rows.push(ok(`${needs}: installed`));
    else rows.push(packager ? { level: 'todo', text: `${needs}: not installed. Claude Code's sandbox needs it.`, needs } : { level: 'fail', text: `${needs}: not installed. Install it yourself.` });
  }
  if ((await fs.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1') {
    rows.push({
      level: 'warn',
      text: 'Sandbox: Ubuntu’s AppArmor forbids the user namespaces that bubblewrap uses, so every card and answer fails.',
      // From Claude Code's sandbox page, "Ubuntu and AppArmor": a profile that lets only bubblewrap use them, not the system-wide switch.
      fix: `Setup changes no security setting. If \`which bwrap\` says /usr/bin/bwrap, run this to let only bubblewrap use them:
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
https://code.claude.com/docs/en/sandboxing has the details, under "Ubuntu and AppArmor".`,
    });
  }
  return rows;
}

async function diskRow(): Promise<Row> {
  const { bavail, bsize } = await fs.statfs(os.homedir());
  const free = (bavail * bsize) / GIB;
  const text = `Disk space: ${free.toFixed(1)} GiB free`;
  return free < 2 ? { level: 'warn', text: `${text}. Clones and runs need room.` } : ok(text);
}

async function networkRow(server: string | undefined): Promise<Row> {
  if (!server) return ok('Network: not paired yet, so nothing to reach');
  try {
    const { release } = await new Api(server).request<ConfigDTO>('GET', '/config');
    if (release === pkg.version) return ok(`Network: ${server} answers, release ${release}`);
    return {
      level: 'warn',
      text: `Network: ${server} runs release ${release ?? 'unknown'}, and this agent is ${pkg.version}.`,
      fix: 'It works, but run the line in WebChat’s Connect dialog again to get the matching agent.',
    };
  } catch (error) {
    return { level: 'fail', text: `Network: ${server} did not answer. ${messageOf(error)}` };
  }
}

/** A supported harness as this laptop has it, for the summary and for the owner's picks. */
interface Found {
  id: string;
  name: string;
  command: string;
  program?: string;
  version?: string;
  signedIn?: boolean;
}

/**
 * Each supported harness: where it is, its version, whether it is signed in, and whether the owner
 * linked it, from the setup the agent keeps (docs/decisions/harness-linking.md). `Found` says what
 * the owner can pick; the rows are `harnessRow`'s four states.
 */
async function harnessRows(home: string, said?: RoomStatus): Promise<{ rows: Row[]; found: Found[] }> {
  const dataDir = path.join(home, 'laptop');
  const adapters = await harnessFinder({ dataDir })();
  // The keyholder holds what the owner linked; a laptop from before the room still has it in a file the owner reads.
  const stored: Partial<SetupChoice> | undefined = said?.linked ? { linked: said.linked } : (await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8').then((t) => JSON.parse(t) as { choice?: SetupChoice }, () => null))?.choice;
  const found: Found[] = await Promise.all(
    adapters.map(async (adapter, i) => {
      const { id, name, command } = SUPPORTED[i]!;
      const { path: program, version, signedIn } = await adapter.found();
      return { id, name, command, program, version, signedIn };
    }),
  );
  const rows = await Promise.all(
    found.map(async ({ id, name, command, program, version, signedIn }, i): Promise<Row> => {
      const linked = !!stored?.linked?.includes(name) && !stored.off?.includes(name);
      const problem = await adapters[i]!.refusal();
      const state: HarnessState = { name, path: program, linked, ...(linked && (problem || signedIn === false) && { attention: problem ?? 'Not signed in.' }), knobs: [] };
      const kind = harnessRow(state);
      if (kind === 'missing') return id === 'claude' ? { level: 'todo', text: `${name}: not installed. The agent can run its cards and answers with it.`, needs: 'claude' } : ok(`${name}: not installed.`);
      const text = `${name}${version ? ` ${version}` : ''}${signedIn ? ', signed in' : ''}: ${HARNESS_ROW_WORDS[kind].toLowerCase()}.`;
      return problem || signedIn === false ? { level: 'warn', text, fix: problem ?? `Run \`${command}\` once and sign in.` } : ok(text);
    }),
  );
  return { rows, found };
}

/** What the running keyholder says about itself, or undefined when it does not answer. */
const askRoom = (layout: Layout) => callRoom<RoomStatus>(socketOf(layout), 'status', {}, pkg.version).catch(() => undefined);

/** Whether root owns a file that nobody else writes, by `stat`. */
async function rootOwned(file: string, layout: Layout) {
  const stat = await fs.stat(file).catch(() => null);
  return !!stat && stat.uid === layout.rootUid && !(stat.mode & 0o022);
}

/** Read-only commands, which need no sudo: `dscl` and `getent` list accounts to anyone. */
export const read: Read = (argv) => run(argv[0]!, argv.slice(1)).then((out) => out, () => undefined);

/** The keyholder's service as the system says it, without sudo. */
async function keyholderState(layout: Layout): Promise<'running' | 'stopped' | 'missing'> {
  if (!existsSync(layout.unit)) return 'missing';
  const said = mac() ? await run('launchctl', ['print', `system/${layout.label}`]).catch(() => '') : await run('systemctl', ['is-active', layout.label]).catch(() => '');
  return (mac() ? /state = running/.test(said) : said.trim() === 'active') ? 'running' : 'stopped';
}

/** The locked room: the account, what root owns, the service, the owner's group and the agent's own GitHub login. */
async function roomRows(layout: Layout, home: string, said?: RoomStatus): Promise<Row[]> {
  const owner = os.userInfo().username;
  const found = await inspectRoom(layout, read);
  const refused = refusals(layout, owner, found);
  if (refused.length) return refused.map((text) => ({ level: 'fail', text: `Agent account: ${text}` }));
  const rows: Row[] = [];
  if (!ghAsset(process.platform, os.arch())) rows.push({ level: 'fail', text: `GitHub CLI: none ships for ${process.platform} on ${os.arch()}.` });
  // A live Claude Code window holds the plugin's account, which setup moves; it must be closed first.
  const moving = newest((await sources(path.join(home, 'laptop'))).filter((s) => s.plugin && s.holder));
  if (moving) rows.push({ level: 'fail', text: `Agent account: a Claude Code window runs the plugin's agent (process ${moving.holder}).`, fix: 'Quit every Claude Code window, then run setup again: it moves that account into the agent’s own folder.' });
  if (found.user === 'none') return [...rows, { level: 'todo', text: `Agent account: ${layout.user} is not made yet. Setup makes it, with your administrator password.` }];
  rows.push(ok(`Agent account: ${layout.user}, made by setup`));
  const installed = await Promise.all([programOf(layout), ghOf(layout)].map((file) => rootOwned(file, layout)));
  rows.push(installed.every(Boolean) ? ok(`Agent program and GitHub CLI: root-owned in ${layout.programDir}`) : { level: 'todo', text: `Agent program and GitHub CLI: missing, or not owned by root alone, in ${layout.programDir}.` });
  const state = await keyholderState(layout);
  rows.push(state === 'running' ? ok(`Keyholder service: running${said ? (said.runner ? ', the runner is connected' : ', no runner connected') : ''}`) : { level: state === 'missing' ? 'todo' : 'warn', text: `Keyholder service: ${state === 'missing' ? 'not installed' : 'installed, but not running'}.`, ...(state === 'stopped' && { fix: mac() ? `macOS may have turned it off: look under System Settings > General > Login Items > Allow in the Background. Its log is ${layout.log}.` : `Its log is in \`journalctl -u ${layout.label}\`.` }) });
  if (!found.members.includes(owner)) rows.push({ level: 'todo', text: `Group: you are not in ${layout.ipcGroup}, which opens the agent’s socket.` });
  else if (!(await run('id', ['-Gn']).catch(() => '')).split(/\s+/).includes(layout.ipcGroup)) rows.push({ level: 'warn', text: `Group: you are in ${layout.ipcGroup}, but this session started before that.`, fix: 'Log out and log in again, so the commands and the runner can reach the keyholder.' });
  if (said && state === 'running' && said.signedIn === false) rows.push({ level: 'warn', text: 'GitHub: the agent is not signed in. Cards and clones need it.', fix: 'Run `webchat-agent setup` and answer yes to its GitHub sign-in. A second GitHub account is best: whatever the agent’s login reaches, the agent reaches.' });
  return rows;
}

/** The packager that installs software here, when there is one: macOS has none to offer, since Apple's installer brings git. */
const packagerOf = async () => (mac() ? '' : ((await onPath('apt-get')) && 'apt-get') || ((await onPath('dnf')) && 'dnf') || '');

/** The read-only checks. The caller's PATH is already the login shell's. */
async function checks(home: string, layout: Layout, server?: string) {
  const packager = await packagerOf();
  const said = await askRoom(layout);
  const [system, admin, service, git, sandbox, disk, network, { rows: harnessRowsList, found }, room] = await Promise.all([
    systemRow(),
    adminRow(),
    serviceRow(),
    gitRow(packager, layout),
    mac() ? [] : sandboxRows(packager),
    diskRow(),
    networkRow(server ?? said?.server),
    harnessRows(home, said),
    roomRows(layout, home, said),
  ]);
  return { packager, admin, found, said, rows: [system, admin, service, git, ...sandbox, disk, network, ...harnessRowsList, ...room] as Row[] };
}

function show(rows: Row[]) {
  for (const { level, text, fix } of rows) {
    console.log(`  ${level.padEnd(4)}  ${text}`);
    if (fix) console.log(fix.replace(/^/gm, '        '));
  }
}

/** One thing setup does for the packages and the harness, as the question says it, with the commands that do it. */
interface Step {
  say: string;
  commands: string[][];
}

export function installSteps(needs: Array<NonNullable<Row['needs']>>, platform: NodeJS.Platform, packager: string): Step[] {
  const steps: Step[] = [];
  const packages = needs.filter((n) => n !== 'claude' && n !== 'codex' && !(platform === 'darwin' && n === 'git'));
  if (platform === 'darwin' && needs.includes('git')) steps.push({ say: 'install git with Apple’s command line tools: their installer opens a window', commands: [['xcode-select', '--install']] });
  if (packages.length) {
    const commands = packager === 'apt-get' ? [['sudo', 'apt-get', 'update']] : [];
    steps.push({ say: `install ${new Intl.ListFormat('en').format(packages)} with ${packager}: it asks for your password`, commands: [...commands, ['sudo', packager, 'install', '-y', ...packages]] });
  }
  if (needs.includes('claude')) steps.push({ say: `install Claude Code with its own installer: ${CLAUDE_INSTALL}`, commands: [['sh', '-c', CLAUDE_INSTALL]] });
  if (needs.includes('codex')) steps.push({ say: `install Codex with its own installer: ${CODEX_INSTALL}`, commands: [['sh', '-c', CODEX_INSTALL]] });
  return steps;
}

/** Runs a command with the terminal as its output, so an installer or a password prompt shows. */
const inherit = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) =>
    spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
      .on('error', reject)
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${[cmd, ...args].join(' ')} failed with code ${code}.`)))),
  );

/** `xcode-select --install` returns when its window opens, so wait until the tools are there. */
async function waitForTools() {
  console.log('Finish Apple’s installer window. Setup goes on when it is done.');
  for (let waited = 0; waited < 30 * 60_000; waited += 5000) {
    if (await works('xcode-select', ['-p'])) return;
    await sleep(5000);
  }
  throw new Error('Apple’s installer did not finish within 30 minutes. Run `webchat-agent setup` again once it has.');
}

/**
 * Asks on the terminal, not on stdin: the line runs under `curl … | sh`, where stdin is the script.
 * Returns the line typed.
 */
async function askLine(question: string) {
  const input = createReadStream('/dev/tty');
  await new Promise((resolve, reject) => input.once('open', resolve).once('error', reject)).catch(() => {
    throw new Error('Setup asks a question, so run it in a terminal.');
  });
  const lines = readline.createInterface({ input, output: process.stdout });
  const answer = await lines.question(question);
  lines.close();
  input.destroy();
  return answer;
}

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());
const confirm = async (question: string) => yes(await askLine(question));

/**
 * The harnesses an answer to setup's question links: yes takes the ticked ones, those found and
 * signed in; names take exactly those; `none` takes none; anything else stops setup.
 */
export function linksFrom(answer: string, found: Found[]) {
  const text = answer.trim().toLowerCase();
  if (yes(text)) return found.filter((f) => f.program && f.signedIn);
  if (text === 'none') return [];
  const named = text.split(/[\s,]+/).map((word) => found.find((f) => f.id === supported(word)?.id));
  return text && named.every(Boolean) ? [...new Set(named as Found[])] : undefined;
}

/** Pairs this laptop's account with the owner who made the code, once they approve in WebChat. */
export async function pairInto(file: string, pasted: string, picks?: PairingPick[]) {
  const { server, code } = readPairing(pasted, '');
  console.log('Approve the agent in WebChat, in the window that shows the code.');
  const client = await AgentClient.pair(file, server, code, undefined, picks);
  await client.sync();
  console.log(`Paired with ${client.users.get(client.owner!)?.displayName}.`);
}

interface Options {
  home: string;
  /** The webchat-agent file this runs from, which setup installs root-owned. Empty when this is not the single file. */
  program: string;
  /** Asks the one question and returns what was typed. */
  ask?: (question: string) => Promise<string>;
  /** The room's names and places. Tests give one of their own. */
  layout?: Layout;
  /** Runs what needs root. Left out, setup asks for the administrator password once and runs `sudo`. */
  root?: Root;
  /** The GitHub CLI's archive, checked against its pinned sum. Tests give one of their own. */
  ghArchive?: () => Promise<Buffer>;
  /** What setup reads of the accounts and groups, which tests answer for a layout that is not on this system. */
  read?: Read;
}

const defaultLayout = () => layoutFor(mac() ? 'darwin' : 'linux');

/** Asks for the administrator password once, and keeps sudo's cache warm while setup runs. Returns what stops that. */
async function openSudo() {
  await inherit('sudo', ['-v']);
  const keep = setInterval(() => void run('sudo', ['-n', '-v']).catch(() => undefined), 60_000);
  return () => clearInterval(keep);
}

/** The program's bytes, read again now and checked against the hash taken when setup started, so a swap in between is caught. */
export async function verifiedProgram(program: string, hash: string) {
  const bytes = await fs.readFile(program);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`${program} changed while setup ran, so setup did not install it. Run setup again.`);
  return bytes;
}

/** Where `~/.local/bin/webchat-agent` is, the name the installer gives the program. */
const linkFile = () => path.join(os.homedir(), '.local', 'bin', 'webchat-agent');

/**
 * Makes the account and groups, the folders, and the root-owned program and `gh`: all of the room but
 * its service, which waits for the account the owner pairs or moves in. `look` reads the system's lists.
 */
export async function buildRoom(root: Root, layout: Layout, { owner, program, hash, look = read, gh = () => ghArchive(ghAsset(process.platform, os.arch())!) }: { owner: string; program: string; hash: string; look?: Read; gh?: () => Promise<Buffer> }) {
  const ids = layout.platform === 'darwin' ? freeIds([...idsOf((await look(['dscl', '.', '-list', '/Users', 'UniqueID'])) ?? ''), ...idsOf((await look(['dscl', '.', '-list', '/Groups', 'PrimaryGroupID'])) ?? '')], 2) : [];
  await runAll(root, [...createPlan(layout, owner, await inspectRoom(layout, look), ids), ...foldersPlan(layout), ...programPlan(layout, await verifiedProgram(program, hash))]);
  if ((await sha256(programOf(layout))) !== hash) throw new Error(`${programOf(layout)} is not the program you ran. Run setup again.`);
  await root(ghPlan(layout, await gh()));
}

export async function setup(pasted: string | undefined, { home, program, ask = askLine, layout = defaultLayout(), root: given, ghArchive: fetchGh, read: look = read }: Options) {
  if (!program) throw new Error('Setup installs the webchat-agent file that a release ships. Run the line in WebChat’s Connect dialog.');
  const owner = os.userInfo().username;
  const daemon = path.join(home, 'laptop');
  const account = await readAccount(home);
  const source = newest(await sources(daemon));
  const said = await askRoom(layout);
  const server = pasted ? readPairing(pasted, '').server : (account ?? source)?.server ?? said?.server;
  const built = (await inspectRoom(layout, look)).user === 'ours';
  if (!server && !built) throw new Error('Paste the whole code that WebChat shows: webchat-agent setup <code>.');
  const hash = await sha256(program);
  const pathEnv = (process.env.PATH = servicePath(await loginPath(), os.homedir()));
  const { packager, admin, rows, found } = await checks(home, layout, server);
  // Before anything else, and alone: the rest of the summary would only bury it.
  if (admin.level === 'fail') {
    show([admin]);
    throw new Error('Nothing was changed.');
  }
  console.log('This laptop:');
  show(rows);
  if (rows.some((row) => row.level === 'fail')) throw new Error('Fix what failed above, then run setup again. Nothing was changed.');

  // The owner picks what to link only with a new pairing, since the picks ride it (docs/decisions/harness-linking.md).
  const ticked = found.filter((f) => f.program && f.signedIn);
  const describe = (f: Found) => (f.program ? `${f.name}${f.version ? ` ${f.version}` : ''}, ${f.signedIn === undefined ? 'sign-in unknown' : f.signedIn ? 'signed in' : 'not signed in'}` : `${f.name}, not installed${f.id === 'codex' ? ': linking it installs it' : ''}`);
  const stepsFor = (picks: Found[]) => installSteps([...rows.flatMap((row) => row.needs ?? []), ...(picks.some((f) => f.id === 'codex' && !f.program) ? ['codex' as const] : [])], process.platform, packager);
  const moves = !pasted && !!source && !said?.paired;
  const plan = [
    ...(pasted ? [`pair with ${server}: you approve the agent in WebChat`] : []),
    ...(built ? [] : [`make the hidden account ${layout.user}, which holds the agent’s keys where no program of yours can read them, and the group ${layout.ipcGroup} with only you in it: this needs your administrator password`]),
    `install the agent and GitHub’s CLI ${GH_VERSION}, owned by root, in ${layout.programDir}, and run the keyholder from there as ${layout.user}: ${mac() ? 'a LaunchDaemon' : 'a systemd service'} in ${path.dirname(layout.unit)}`,
    ...(moves ? [`move the agent’s account from ${source.dir} into its own folder, without pairing again`] : []),
    ...stepsFor(ticked).map((step) => step.say),
    `install a login service that runs the agent’s runner as you, a ${mac() ? 'LaunchAgent' : 'systemd user unit'} in ${path.dirname(mac() ? plistFile() : unitFile())}`,
  ];
  const offer = pasted ? `\nCoding agents to link, which WebChat shows you before you approve:\n${found.map((f) => `  [${ticked.includes(f) ? 'x' : ' '}] ${describe(f)}`).join('\n')}\n` : '';
  const answer = await ask(`${offer}\nSetup will:\n${plan.map((line) => `  - ${line}`).join('\n')}\nIt changes no security setting. Continue? [y/N]${pasted ? ', or type the coding agents to link, such as "claude codex", or "none"' : ''} `);
  const picks = pasted ? linksFrom(answer, found) : yes(answer) ? [] : undefined;
  if (!picks) throw new Error('Nothing was changed.');
  const steps = stepsFor(picks);

  const stopSudo = given ? () => undefined : await openSudo();
  const root = given ?? realRoot;
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await buildRoom(root, layout, { owner, program, hash, look, gh: fetchGh });
    // First, while the owner is at WebChat: the code lapses after 10 minutes, and Apple's installer can take longer.
    if (pasted) await root(pairPlan(layout, { code: pasted, picks: picks.map((f) => ({ name: f.name, ...(f.version && { version: f.version }), ...(f.signedIn !== undefined && { signedIn: f.signedIn }) })) }));
    for (const step of steps) for (const [cmd, ...args] of step.commands) await inherit(cmd, args);
    if (rows.some((row) => row.needs === 'git') && mac()) await waitForTools();

    // The old login service holds the daemon's account, so it stops before the account moves; a plugin's window must be closed.
    let moved: string[] = [];
    if (moves && (await root({ argv: ['test', '-e', path.join(layout.data, 'laptop', 'account.json')] }).then(() => false, () => true))) {
      await removeService();
      const busy = (await sources(daemon)).find((s) => s.holder);
      if (busy) throw new Error(`The agent’s account is in use by process ${busy.holder}. Quit every Claude Code window, then run setup again.`);
      moved = await moveAccount(root, layout, source, path.join(home, 'runner'));
    }
    await runAll(root, servicePlan(layout, programOf(layout)));
    if (await root(signedInPlan(layout)).then(() => false, () => true)) {
      const reply = await ask('\nThe agent needs its own GitHub login for cards and clones. A second GitHub account is best: whatever its login reaches, the agent reaches. Sign it in now? GitHub shows a code to enter at github.com/login/device. [y/N] ');
      if (yes(reply)) await root(loginPlan(layout));
      else console.log('Skipped. `webchat-agent doctor` reminds you; `webchat-agent setup` signs it in later.');
    }

    await fs.mkdir(path.join(home, 'runner'), { recursive: true, mode: 0o700 });
    await installService(programOf(layout), pathEnv, home);
    await fs.mkdir(path.dirname(linkFile()), { recursive: true });
    await fs.rm(linkFile(), { force: true });
    await fs.symlink(programOf(layout), linkFile());
    for (let tries = 0; (await serviceState()) !== 'running'; tries++) {
      if (tries === 10) throw new Error(`The login service is installed but does not run. ${logHint(home)}`);
      await sleep(1000);
    }
    // Asked as the owner, in the ipc group, since a session that began before setup is not in it yet.
    const paired = { argv: ['env', `WEBCHAT_SOCKET=${socketOf(layout)}`, programOf(layout), 'status'], as: owner, group: layout.ipcGroup };
    for (let tries = 0; !/Taking the cards/.test(await root(paired).catch(() => '')); tries++) {
      if (tries === 20) throw new Error(`The keyholder does not take the agent’s account. ${keyholderLog(layout)}`);
      await sleep(2000);
    }
    await finishMove(moved);
    if (moved.length) console.log('The agent’s account is in its own folder now, and your copy is deleted.');
  } finally {
    stopSudo();
  }
  console.log('The agent runs as a system service and a login service, and shows as online in WebChat within a minute.');
  const left = (await checks(home, layout, server)).rows.filter((row) => row.level !== 'ok');
  if (left.length) {
    console.log('\nStill to do:');
    show(left);
  }
}

const logHint = (home: string) => (mac() ? `Its log is ${path.join(home, 'agent.log')}.` : `Its log is in \`journalctl --user -u ${NAME}\`.`);
const keyholderLog = (layout: Layout) => (mac() ? `Its log is ${layout.log}.` : `Its log is in \`journalctl -u ${layout.label}\`.`);

export async function doctor(home: string, layout = defaultLayout()) {
  process.env.PATH = servicePath(await loginPath(), os.homedir());
  const { rows } = await checks(home, layout, (await readAccount(home))?.server);
  show(rows);
  if (rows.some((row) => row.level === 'todo')) console.log('\nRun `webchat-agent setup` to install what is missing.');
  if (rows.some((row) => row.level !== 'ok')) process.exitCode = 1;
}

export async function status(home: string, layout = defaultLayout()) {
  const [keyholder, login, account] = [await keyholderState(layout), await serviceState(), await readAccount(home)];
  console.log(`Keyholder service: ${{ running: 'running', stopped: `installed, but not running. ${keyholderLog(layout)}`, missing: 'not installed. Run `webchat-agent setup <code>`.' }[keyholder]}`);
  console.log(`Runner service: ${{ running: 'running', stopped: `installed, but not running. ${logHint(home)}`, missing: 'not installed. Run `webchat-agent setup`.' }[login]}`);
  if (account) console.log(`Account from before the room, still in ${accountFile(home)}: ${account.username} on ${account.server}. Run \`webchat-agent setup\` to move it.`);
}

export async function uninstall(home: string, ask = confirm, { layout = defaultLayout(), root: given, read: look = read }: { layout?: Layout; root?: Root; read?: Read } = {}) {
  const found = await inspectRoom(layout, look);
  if ([found.user, found.group, found.ipc].includes('foreign')) throw new Error(`${layout.user} or ${layout.ipcGroup} is not an account setup made, so setup leaves it alone. Nothing was removed.`);
  if (!(await ask(`This stops the agent on this laptop and deletes its keys, the account ${layout.user} and the agent’s copies of your repositories. Continue? [y/N] `))) throw new Error('Nothing was removed.');
  const built = found.user !== 'none' || found.ipc !== 'none' || [layout.unit, layout.data, layout.ipc, layout.programDir].some((file) => existsSync(file));
  const stopSudo = given || !built ? () => undefined : await openSudo();
  try {
    if (built) await runAll(given ?? realRoot, uninstallPlan(layout, found.user === 'ours'));
  } finally {
    stopSudo();
  }
  await removeService();
  // The account and the agent.log that a laptop from before the room kept in the owner's folders.
  await Promise.all([path.join(home, 'runner'), path.join(home, 'laptop'), path.join(home, 'agent.log'), linkFile()].map((file) => fs.rm(file, { recursive: true, force: true })));
  console.log('Removed both services and the agent’s account on this laptop.');
  console.log('The agent stays in WebChat until you remove it under Coding agents. The repositories it cloned in ~/WebChat stay on this laptop.');
  console.log('The agent’s GitHub login is signed out here, but it stays valid on GitHub until you revoke it: github.com/settings/applications, under Authorized OAuth Apps.');
  console.log('Revoking “GitHub CLI” there revokes every `gh` login of that GitHub account, including your own on your laptop. If the agent used your own account, run `gh auth login` again afterwards.');
}
