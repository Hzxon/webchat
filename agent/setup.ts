// The daemon's setup commands (docs/roadmap/new-agent-setup.md, docs/decisions/agent-install.md).
// `setup` checks the laptop read-only, asks once, then pairs, installs what is missing and a login
// service that runs `serve`. `doctor` repeats the checks, `status` says what runs, and `uninstall`
// takes the service and the account away. Nothing here changes a security setting: where one
// blocks the agent, it prints the fix.
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import type { ConfigDTO } from '../shared/types.ts';
import { Api } from './api.ts';
import { claudeHarness, onPath } from './claude.ts';
import { AgentClient, readPairing, type AccountFile } from './client.ts';
import { codexHarness } from './codex.ts';
import { messageOf } from './runs.ts';

const exec = promisify(execFile);
/** The service's name on both systems: webchat-agent.plist, webchat-agent.service. */
const NAME = 'webchat-agent';
/** Claude Code's own installer, which puts `claude` in ~/.local/bin. */
const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const GIB = 2 ** 30;

/** One line of the summary. `needs` names what setup would install for a `todo`. */
interface Row {
  level: 'ok' | 'warn' | 'todo' | 'fail';
  text: string;
  fix?: string;
  needs?: 'git' | 'bubblewrap' | 'socat' | 'claude';
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

const xml = (text: string) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** The LaunchAgent: it starts at login and again whenever `serve` exits. */
export const launchdPlist = (program: string, pathEnv: string, log: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>serve</string>
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

/** A value in double quotes for a unit file: `\`, `"` and the specifier `%` escaped, and `$` too on a line that expands variables. */
const quoted = (value: string, variables = false) => {
  const escaped = value.replace(/[\\"]/g, '\\$&').replaceAll('%', '%%');
  return `"${variables ? escaped.replaceAll('$', () => '$$') : escaped}"`;
};

/** The `systemd --user` unit. RestartSec keeps a `serve` that fails at once from hitting systemd's start limit. */
export const systemdUnit = (program: string, pathEnv: string) => `[Unit]
Description=WebChat agent
After=network-online.target

[Service]
ExecStart=${quoted(program, true)} serve
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

async function gitRow(packager: string): Promise<Row> {
  // On macOS /usr/bin/git is a stub that opens Apple's installer, so it counts only with the tools behind it.
  const git = mac() ? (await works('xcode-select', ['-p'])) || !['', '/usr/bin/git'].includes(await onPath('git')) : !!(await onPath('git'));
  if (git) return ok('git: installed');
  return mac() || packager ? { level: 'todo', text: 'git: not installed.', needs: 'git' } : { level: 'fail', text: 'git: not installed, and there is neither apt-get nor dnf to install it. Install it yourself.' };
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

/** Where a harness is, with its version and whether it is signed in, from its adapter. */
async function harnessRows(home: string): Promise<Row[]> {
  const [claude, codex] = await Promise.all([onPath('claude'), onPath('codex')]);
  const [c, x] = await Promise.all([claude ? claudeHarness(claude, '', home).found() : {}, codex ? codexHarness(codex, home).found() : {}]);
  const seen = (name: string, found: { version?: string; signedIn?: boolean }, fix: string): Row => {
    const text = `${name}${found.version ? ` ${found.version}` : ''}`;
    return found.signedIn === false ? { level: 'warn', text: `${text} is not signed in.`, fix } : ok(`${text}${found.signedIn ? ', signed in' : ''}`);
  };
  return [
    claude ? seen('Claude Code', c, 'Run `claude` once and sign in.') : { level: 'todo', text: 'Claude Code: not installed. The agent runs its cards and answers with it.', needs: 'claude' },
    codex ? seen('Codex', x, 'Run `codex` once and sign in.') : ok('Codex: not installed. The agent does not run it yet.'),
  ];
}

/** Cards and clones push with the owner's `gh`; questions need neither. */
async function githubRow(): Promise<Row> {
  if (!(await onPath('gh'))) return { level: 'warn', text: 'GitHub CLI: not installed. Cards and clones need it.', fix: 'Install it from https://cli.github.com, then run `gh auth login` and `gh auth setup-git`.' };
  if (await works('gh', ['auth', 'status', '--hostname', 'github.com'])) return ok('GitHub CLI: signed in');
  return { level: 'warn', text: 'GitHub CLI: not signed in. Cards and clones need it.', fix: 'Run `gh auth login`, then `gh auth setup-git`.' };
}

/** The packager that installs software here, when there is one: macOS has none to offer, since Apple's installer brings git. */
const packagerOf = async () => (mac() ? '' : ((await onPath('apt-get')) && 'apt-get') || ((await onPath('dnf')) && 'dnf') || '');

/** The read-only checks. The caller's PATH is already the login shell's. */
async function checks(home: string, server?: string) {
  const packager = await packagerOf();
  const [system, admin, service, git, sandbox, disk, network, harnesses, github] = await Promise.all([
    systemRow(),
    adminRow(),
    serviceRow(),
    gitRow(packager),
    mac() ? [] : sandboxRows(packager),
    diskRow(),
    networkRow(server),
    harnessRows(home),
    githubRow(),
  ]);
  return { packager, admin, rows: [system, admin, service, git, ...sandbox, disk, network, ...harnesses, github] as Row[] };
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
  const packages = needs.filter((n) => n !== 'claude' && !(platform === 'darwin' && n === 'git'));
  if (platform === 'darwin' && needs.includes('git')) steps.push({ say: 'install git with Apple’s command line tools: their installer opens a window', commands: [['xcode-select', '--install']] });
  if (packages.length) {
    const commands = packager === 'apt-get' ? [['sudo', 'apt-get', 'update']] : [];
    steps.push({ say: `install ${new Intl.ListFormat('en').format(packages)} with ${packager}: it asks for your password`, commands: [...commands, ['sudo', packager, 'install', '-y', ...packages]] });
  }
  if (needs.includes('claude')) steps.push({ say: `install Claude Code with its own installer: ${CLAUDE_INSTALL}`, commands: [['sh', '-c', CLAUDE_INSTALL]] });
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
 * Only a yes counts.
 */
async function askTerminal(question: string) {
  const input = createReadStream('/dev/tty');
  await new Promise((resolve, reject) => input.once('open', resolve).once('error', reject)).catch(() => {
    throw new Error('Setup asks a question, so run it in a terminal.');
  });
  const lines = readline.createInterface({ input, output: process.stdout });
  const answer = await lines.question(question);
  lines.close();
  input.destroy();
  return /^y(es)?$/i.test(answer.trim());
}

/** Pairs this laptop's account with the owner who made the code, once they approve in WebChat. */
export async function pairInto(file: string, pasted: string) {
  const { server, code } = readPairing(pasted, '');
  console.log('Approve the agent in WebChat, in the window that shows the code.');
  const client = await AgentClient.pair(file, server, code);
  await client.sync();
  console.log(`Paired with ${client.users.get(client.owner!)?.displayName}.`);
}

interface Options {
  home: string;
  /** The installed webchat-agent, which the service runs. Empty when this is not the single file. */
  program: string;
  ask?: (question: string) => Promise<boolean>;
}

export async function setup(pasted: string | undefined, { home, program, ask = askTerminal }: Options) {
  if (!program) throw new Error('Setup installs the webchat-agent file that a release ships. Run the line in WebChat’s Connect dialog.');
  const account = await readAccount(home);
  const server = pasted ? readPairing(pasted, '').server : account?.server;
  if (!server) throw new Error('Paste the whole code that WebChat shows: webchat-agent setup <code>.');
  const pathEnv = (process.env.PATH = servicePath(await loginPath(), os.homedir()));
  const { packager, admin, rows } = await checks(home, server);
  // Before anything else, and alone: the rest of the summary would only bury it.
  if (admin.level === 'fail') {
    show([admin]);
    throw new Error('Nothing was changed.');
  }
  console.log('This laptop:');
  show(rows);
  if (rows.some((row) => row.level === 'fail')) throw new Error('Fix what failed above, then run setup again. Nothing was changed.');

  const steps = installSteps(rows.flatMap((row) => row.needs ?? []), process.platform, packager);
  const plan = [
    ...(pasted ? [`pair with ${server}: you approve the agent in WebChat`] : []),
    ...steps.map((step) => step.say),
    `install a login service that runs the agent, a ${mac() ? 'LaunchAgent' : 'systemd user unit'} in ${path.dirname(mac() ? plistFile() : unitFile())}`,
  ];
  if (!(await ask(`\nSetup will:\n${plan.map((line) => `  - ${line}`).join('\n')}\nIt changes no security setting. Continue? [y/N] `))) throw new Error('Nothing was changed.');

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  // First, while the owner is at WebChat: the code lapses after 10 minutes, and Apple's installer can take longer.
  if (pasted) await pairInto(accountFile(home), pasted);
  for (const step of steps) for (const [cmd, ...args] of step.commands) await inherit(cmd, args);
  if (rows.some((row) => row.needs === 'git') && mac()) await waitForTools();
  await installService(program, pathEnv, home);
  for (let tries = 0; (await serviceState()) !== 'running'; tries++) {
    if (tries === 10) throw new Error(`The login service is installed but does not run. ${logHint(home)}`);
    await sleep(1000);
  }
  console.log('The agent runs as a login service, and shows as online in WebChat within a minute.');
  const left = (await checks(home, server)).rows.filter((row) => row.level !== 'ok');
  if (left.length) {
    console.log('\nStill to do:');
    show(left);
  }
}

const logHint = (home: string) => (mac() ? `Its log is ${path.join(home, 'agent.log')}.` : `Its log is in \`journalctl --user -u ${NAME}\`.`);

export async function doctor(home: string) {
  process.env.PATH = servicePath(await loginPath(), os.homedir());
  const { rows } = await checks(home, (await readAccount(home))?.server);
  show(rows);
  if (rows.some((row) => row.level === 'todo')) console.log('\nRun `webchat-agent setup` to install what is missing.');
  if (rows.some((row) => row.level !== 'ok')) process.exitCode = 1;
}

export async function status(home: string) {
  const account = await readAccount(home);
  const state = await serviceState();
  console.log(`Service: ${{ running: 'running', stopped: `installed, but not running. ${logHint(home)}`, missing: 'not installed. Run `webchat-agent setup <code>`.' }[state]}`);
  console.log(account ? `Paired: yes, as ${account.username} on ${account.server}` : 'Paired: no. Run `webchat-agent setup <code>` with a code from WebChat.');
  console.log(`Asleep: ${existsSync(path.join(home, 'laptop', 'asleep')) ? 'yes. Run `webchat-agent wake` to wake it.' : 'no'}`);
}

export async function uninstall(home: string, ask = askTerminal) {
  if (!(await ask(`This stops the agent on this laptop and deletes its keys in ${path.join(home, 'laptop')}. Continue? [y/N] `))) throw new Error('Nothing was removed.');
  await removeService();
  await fs.rm(path.join(home, 'laptop'), { recursive: true, force: true });
  await fs.rm(path.join(home, 'agent.log'), { force: true });
  console.log('Removed the login service and the agent’s account on this laptop.');
  console.log('The agent stays in WebChat until you remove it under Coding agents. Its program, and the repositories it cloned in ~/WebChat, stay on this laptop.');
}
