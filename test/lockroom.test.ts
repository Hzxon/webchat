// The pure parts of the room setup builds (docs/decisions/locked-room.md): the command lists for
// each system, the service files, the free ids, the pinned `gh` and the hash check. They run on any
// machine, and nothing here runs as root. The whole of setup against a server is in test/agent.test.ts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { GH_VERSION, ghArchive, ghAsset } from '../agent/gh.ts';
import {
  createPlan, foldersPlan, freeIds, ghPlan, idsOf, inspectRoom, keyholderPlist, keyholderUnit, layoutFor, loginPlan, MARK, pairPlan, programOf, put, putAs, refusals, runAll, servicePlan, signedInPlan, uninstallPlan,
  type Cmd, type Found,
} from '../agent/lockroom.ts';
import { uninstall, verifiedProgram } from '../agent/setup.ts';
import { fakeRoom, testLayout } from './fakeRoom.ts';

const mac = layoutFor('darwin');
const linux = layoutFor('linux');
const none: Found = { user: 'none', group: 'none', ipc: 'none', members: [] };
const words = (cmds: Cmd[]) => cmds.map((cmd) => cmd.argv.join(' '));

test('the layout names one account, two groups and a folder for each, on each system', () => {
  assert.deepEqual([mac.user, mac.ipcGroup, mac.data, mac.ipc, mac.programDir, mac.unit, mac.log], ['_webchat', '_webchatipc', '/var/webchat', '/var/webchat-ipc', '/Library/WebChat', '/Library/LaunchDaemons/com.webchat.keyholder.plist', '/Library/Logs/WebChat/keyholder.log']);
  assert.deepEqual([linux.data, linux.ipc, linux.programDir, linux.unit, linux.log], ['/var/lib/webchat', '/var/webchat-ipc', '/opt/webchat', '/etc/systemd/system/webchat-keyholder.service', '']);
  assert.equal(layoutFor('linux', 'test').user, '_webchattest', 'a test layout shares no name with the real one');
  assert.equal(mac.git, '/Library/Developer/CommandLineTools/usr/bin/git');
});

test('creates the account and groups on macOS: ids in the role range, the mark, hidden, the owner in the ipc group alone', () => {
  const plan = words(createPlan(mac, 'ann', none, [450, 451]));
  assert.deepEqual(plan, [
    `dseditgroup -o create -i 451 -r ${MARK} _webchatipc`,
    `dseditgroup -o create -i 450 -r ${MARK} _webchat`,
    `sysadminctl -addUser _webchat -fullName ${MARK} -UID 450 -GID 450 -shell /usr/bin/false -roleAccount`,
    'dscl . create /Users/_webchat IsHidden 1',
    'dseditgroup -o edit -a ann -t user _webchatipc',
  ]);
  // A rerun makes only what is missing, and an account half made starts over from its group.
  assert.deepEqual(words(createPlan(mac, 'ann', { user: 'ours', group: 'ours', ipc: 'ours', members: ['ann'] }, [])), []);
  assert.deepEqual(words(createPlan(mac, 'ann', { user: 'none', group: 'ours', ipc: 'ours', members: ['ann'] }, [450])).slice(0, 2), ['dseditgroup -o delete _webchat', `dseditgroup -o create -i 450 -r ${MARK} _webchat`]);
});

test('creates the account and groups on Linux as system ones, with the mark in the comment', () => {
  assert.deepEqual(words(createPlan(linux, 'ann', none, [])), [
    `useradd --system --user-group --no-create-home --home-dir /var/lib/webchat --shell /usr/sbin/nologin --comment ${MARK} _webchat`,
    'groupadd --system _webchatipc',
    'usermod -aG _webchatipc ann',
  ]);
  assert.deepEqual(words(createPlan(linux, 'ann', { user: 'ours', group: 'ours', ipc: 'ours', members: ['ann'] }, [])), []);
});

test('makes the folders: data for the account alone, the socket’s with the group bit, root’s for what runs, and the log launchd needs', () => {
  const plan = words(foldersPlan(mac));
  assert.ok(plan.includes('install -d -o _webchat -g _webchat -m 700 /var/webchat'));
  assert.ok(plan.includes('install -d -o _webchat -g _webchatipc -m 2750 /var/webchat-ipc') && plan.includes('chmod 2750 /var/webchat-ipc'));
  assert.ok(plan.includes('install -d -o root -g wheel -m 755 /Library/WebChat /Library/WebChat/bin'));
  assert.deepEqual(plan.slice(-3), ['touch /Library/Logs/WebChat/keyholder.log', 'chown _webchat:_webchatipc /Library/Logs/WebChat/keyholder.log', 'chmod 640 /Library/Logs/WebChat/keyholder.log']);
  assert.ok(words(foldersPlan(linux)).includes('install -d -o root -g root -m 755 /opt/webchat /opt/webchat/bin'));
  assert.ok(!words(foldersPlan(linux)).some((line) => line.startsWith('touch')), 'Linux logs to the journal');
});

test('picks the free ids in 450 to 499, and says so when there are none', () => {
  assert.deepEqual(idsOf('root  0\n_webchat   450\nnobody -2\nbad  x\n'), [0, 450, -2]);
  assert.deepEqual(freeIds([450, 451, 453], 2), [452, 454]);
  assert.deepEqual(freeIds([], 2), [450, 451]);
  assert.throws(() => freeIds(Array.from({ length: 50 }, (_, i) => 450 + i), 1), /Every id from 450 to 499/);
});

test('reads who made an account, and refuses one setup did not make, or a second owner', async () => {
  const room = fakeRoom(testLayout('/x'));
  const layout = testLayout('/x');
  assert.deepEqual(await inspectRoom(layout, room.read), none);
  room.system.made = true;
  room.system.members = ['ann'];
  const ours = await inspectRoom(layout, room.read);
  assert.deepEqual([ours.user, ours.group, ours.ipc, ours.members], ['ours', 'ours', 'ours', ['ann']]);
  assert.deepEqual(refusals(layout, 'ann', ours), []);
  assert.match(refusals(layout, 'bob', ours)[0]!, /_webchattestipc already holds ann\. The agent has one owner per laptop/);
  room.system.foreign = true;
  const foreign = await inspectRoom(layout, room.read);
  assert.equal(foreign.user, 'foreign');
  assert.match(refusals(layout, 'ann', foreign)[0]!, /did not make, so setup leaves it alone/);
});

test('writes generated content through stdin into a folder only root writes, by a rename, and never takes a path from the owner', () => {
  const file = put('/Library/WebChat/webchat-agent', '755', Buffer.from('bytes'));
  assert.deepEqual(file.argv.slice(0, 2), ['sh', '-c']);
  assert.match(file.argv[2]!, /cat > "\$1\.new"; chmod 755 "\$1\.new"; mv -f "\$1\.new" "\$1"/);
  assert.equal(file.argv.at(-1), '/Library/WebChat/webchat-agent', 'the destination is an argument, so it is never part of a script');
  assert.equal(String(file.stdin), 'bytes');
  const own = putAs(mac, '/var/webchat/laptop/account.json', '{}');
  assert.deepEqual([own.as, own.argv[2], own.stdin], ['_webchat', 'set -e; umask 077; mkdir -p "$(dirname "$1")"; cat > "$1"', '{}']);
  const gh = ghPlan(mac, Buffer.from('zip'));
  assert.match(gh.argv[2]!, /mktemp -d "\$1\/\.gh\.XXXXXX".*tar -xof.*install -m 755 -o root -g "\$2"/);
  assert.deepEqual(gh.argv.slice(-2), ['/Library/WebChat', 'wheel']);
});

test('pairs as the role account with the code on stdin, and never in an argument', () => {
  const pair = pairPlan(mac, { code: 'https://x.example#SECRETCODE', picks: [{ name: 'Codex' }] });
  assert.equal(pair.as, '_webchat');
  assert.equal(pair.argv.slice(-2).join(' '), '/Library/WebChat/webchat-agent pair');
  assert.ok(pair.argv.slice(0, 2).join(' ') === 'env -i' && pair.argv.includes('HOME=/var/webchat') && pair.argv.includes('WEBCHAT_AGENT_HOME=/var/webchat'));
  assert.ok(!pair.argv.some((word) => word.includes('SECRETCODE')));
  assert.deepEqual(JSON.parse(String(pair.stdin)), { code: 'https://x.example#SECRETCODE', picks: [{ name: 'Codex' }] });
});

test('signs the agent in to GitHub by the device flow, in its own folder, with the default scopes and no browser', () => {
  const login = loginPlan(mac);
  assert.equal(login.as, '_webchat');
  assert.equal(login.stdio, 'tty');
  assert.ok(login.argv.includes('GH_CONFIG_DIR=/var/webchat/gh') && login.argv.includes('GH_BROWSER=/usr/bin/true') && login.argv.includes('HOME=/var/webchat'));
  assert.ok(!login.argv.includes('GH_PROMPT_DISABLED=1'), 'the sign-in prompts');
  assert.deepEqual(login.argv.slice(login.argv.indexOf('/Library/WebChat/bin/gh')), ['/Library/WebChat/bin/gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage', '--skip-ssh-key']);
  assert.ok(!login.argv.includes('--scopes'), 'no workflow scope');
  assert.deepEqual(signedInPlan(mac).argv.slice(-4), ['auth', 'status', '--hostname', 'github.com']);
});

test('the LaunchDaemon runs the keyholder as the role account from root-owned folders only, and escapes what XML reserves', async () => {
  const plist = keyholderPlist(mac, '/Library/WebChat/webchat-agent');
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Library\/WebChat\/webchat-agent<\/string>\s*<string>keyholder<\/string>/);
  assert.match(plist, /<key>UserName<\/key>\s*<string>_webchat<\/string>\s*<key>GroupName<\/key>\s*<string>_webchat<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>\s*<key>KeepAlive<\/key>\s*<true\/>\s*<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>\s*<key>Umask<\/key>\s*<integer>63<\/integer>/);
  for (const [name, value] of [['HOME', '/var/webchat'], ['GH_CONFIG_DIR', '/var/webchat/gh'], ['GH_NO_UPDATE_NOTIFIER', '1'], ['GH_PROMPT_DISABLED', '1'], ['GIT_TERMINAL_PROMPT', '0'], ['WEBCHAT_SOCKET', '/var/webchat-ipc/keyholder.sock']]) {
    assert.match(plist, new RegExp(`<key>${name}</key>\\s*<string>${value}</string>`));
  }
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/Library\/WebChat\/bin:\/Library\/Developer\/CommandLineTools\/usr\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/, 'no folder the owner writes, such as Homebrew’s');
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Library\/Logs\/WebChat\/keyholder\.log<\/string>/);
  // macOS has the real parser.
  if (process.platform !== 'darwin') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-plist-'));
  try {
    const file = path.join(dir, 'keyholder.plist');
    await fs.writeFile(file, keyholderPlist({ ...mac, user: '_we<b>&', label: 'com.a&b' }, '/Library/We<b>&c/webchat-agent'));
    await promisify(execFile)('plutil', ['-lint', file]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the systemd unit runs the keyholder as the role account in a sandbox with no view of the owner’s folders', () => {
  const unit = keyholderUnit(linux, '/opt/we ird/100%/webchat-agent');
  assert.match(unit, /^User=_webchat$/m);
  assert.match(unit, /^ExecStart="\/opt\/we ird\/100%%\/webchat-agent" keyholder$/m);
  for (const line of ['StateDirectory=webchat', 'StateDirectoryMode=0700', 'UMask=0077', 'ProtectHome=yes', 'ProtectSystem=strict', 'ReadWritePaths=/var/lib/webchat /var/webchat-ipc', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'Restart=always', 'WantedBy=multi-user.target']) {
    assert.ok(unit.split('\n').includes(line), line);
  }
  assert.match(unit, /^Environment="PATH=\/opt\/webchat\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m, 'git is /usr/bin/git, so the folder is listed once');
  assert.match(unit, /^Environment="GH_CONFIG_DIR=\/var\/lib\/webchat\/gh"$/m);
});

test('starts the service from a file written through stdin, then loads it', () => {
  const [file, ...load] = servicePlan(mac, programOf(mac));
  assert.ok(file!.argv.at(-1) === mac.unit && String(file!.stdin).includes('<key>Label</key>'));
  assert.deepEqual(words(load), ['launchctl bootout system/com.webchat.keyholder', `launchctl bootstrap system ${mac.unit}`]);
  const [unit, ...enable] = servicePlan(linux, programOf(linux));
  assert.ok(unit!.argv.at(-1) === linux.unit && String(unit!.stdin).includes('[Service]'));
  assert.deepEqual(words(enable), ['systemctl daemon-reload', 'systemctl enable webchat-keyholder', 'systemctl restart webchat-keyholder']);
});

test('pins a sum for each archive, and installs nothing that does not match it', async () => {
  assert.equal(GH_VERSION, '2.104.0');
  const keys = [['linux', 'x64', 'linux_amd64.tar.gz'], ['linux', 'arm64', 'linux_arm64.tar.gz'], ['darwin', 'x64', 'macOS_amd64.zip'], ['darwin', 'arm64', 'macOS_arm64.zip']] as const;
  for (const [platform, arch, file] of keys) {
    const asset = ghAsset(platform, arch)!;
    assert.deepEqual([asset.name, asset.url, asset.sha256.length], [`gh_2.104.0_${file}`, `https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_${file}`, 64]);
  }
  assert.equal(ghAsset('win32', 'x64'), undefined);
  assert.equal(ghAsset('linux', 'ia32'), undefined);
  const asset = { ...ghAsset('linux', 'x64')!, sha256: createHash('sha256').update('archive').digest('hex') };
  assert.equal((await ghArchive(asset, async () => new Response('archive'))).toString(), 'archive');
  await assert.rejects(ghArchive(asset, async () => new Response('swapped')), /does not match the sum WebChat pins/);
  await assert.rejects(ghArchive(asset, async () => new Response('missing', { status: 404 })), /failed with 404/);
});

test('installs the program only if it is the bytes setup hashed when it started', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-hash-'));
  try {
    const file = path.join(dir, 'webchat-agent');
    await fs.writeFile(file, 'the program');
    const hash = createHash('sha256').update('the program').digest('hex');
    assert.equal((await verifiedProgram(file, hash)).toString(), 'the program');
    await fs.writeFile(file, 'a swapped program');
    await assert.rejects(verifiedProgram(file, hash), /changed while setup ran, so setup did not install it/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('uninstall goes in order, deletes the account and groups only when setup made them, and keeps to its own folders', () => {
  assert.deepEqual(words(uninstallPlan(mac, true)).filter((line) => !line.includes('env -i')), [
    'launchctl bootout system/com.webchat.keyholder',
    'rm -f /Library/LaunchDaemons/com.webchat.keyholder.plist',
    'pkill -KILL -u _webchat',
    'rm -rf /var/webchat /var/webchat-ipc /Library/WebChat /Library/Logs/WebChat',
    'sysadminctl -deleteUser _webchat -secure',
    'dscl . -delete /Users/_webchat',
    'dseditgroup -o delete _webchatipc',
    'dseditgroup -o delete _webchat',
    'rm -rf /var/webchat',
  ]);
  const logout = uninstallPlan(mac, true).find((cmd) => cmd.argv.includes('logout'))!;
  assert.deepEqual([logout.as, logout.soft], ['_webchat', true]);
  assert.deepEqual(logout.argv.slice(-5), ['/Library/WebChat/bin/gh', 'auth', 'logout', '--hostname', 'github.com']);
  assert.deepEqual(words(uninstallPlan(linux, true)).filter((line) => !line.includes('env -i')), [
    'systemctl disable --now webchat-keyholder',
    'rm -f /etc/systemd/system/webchat-keyholder.service',
    'systemctl daemon-reload',
    'pkill -KILL -u _webchat',
    'rm -rf /var/lib/webchat /var/webchat-ipc /opt/webchat',
    'userdel _webchat',
    'groupdel _webchatipc',
    'groupdel _webchat',
    'rm -rf /var/lib/webchat',
  ]);
  // An account that is not setup's stays, and so do the groups; the files setup put in its own folders go.
  assert.ok(!words(uninstallPlan(mac, false)).some((line) => /deleteUser|dscl|dseditgroup|userdel|groupdel/.test(line)));
  assert.throws(() => uninstallPlan({ ...linux, programDir: '/opt' }, true), /Refusing to remove \/opt/);
  assert.throws(() => uninstallPlan({ ...linux, data: '/' }, true), /Refusing to remove/);
  assert.throws(() => uninstallPlan({ ...linux, ipc: 'var/x' }, true), /Refusing to remove/);
});

test('a failing command stops a run of them, unless it is one that may fail', async () => {
  const seen: string[] = [];
  const root = async (cmd: Cmd) => {
    seen.push(cmd.argv[0]!);
    if (cmd.argv[0] === 'bad') throw new Error('failed');
    return '';
  };
  await runAll(root, [{ argv: ['a'] }, { argv: ['bad'], soft: true }, { argv: ['b'] }]);
  await assert.rejects(runAll(root, [{ argv: ['bad'] }, { argv: ['never'] }]), /failed/);
  assert.deepEqual(seen, ['a', 'bad', 'b', 'bad']);
});

test('uninstall refuses an account setup did not make and removes nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-foreign-'));
  try {
    const layout = testLayout(dir);
    const room = fakeRoom(layout);
    room.system = { made: true, members: [], foreign: true };
    await fs.mkdir(layout.data);
    await assert.rejects(uninstall(path.join(dir, 'agent'), async () => true, { layout, root: room.root, read: room.read }), /is not an account setup made, so setup leaves it alone\. Nothing was removed/);
    assert.deepEqual([room.log.length, await fs.stat(layout.data).then(() => true, () => false)], [0, true]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
