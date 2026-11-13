// The pure parts of agent/setup.ts and the check-in pace (docs/roadmap/new-agent-setup.md). The
// whole of `setup` against a server is in test/agent.test.ts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { checkInEvery } from '../agent/client.ts';
import { installSteps, isAdmin, launchdPlist, pathFrom, servicePath, systemdUnit } from '../agent/setup.ts';

test('an administrator is in the admin group on macOS, and in sudo, wheel or admin on Linux', () => {
  assert.equal(isAdmin('staff everyone localaccounts admin _appstore', 'darwin'), true);
  assert.equal(isAdmin('staff everyone localaccounts', 'darwin'), false);
  assert.equal(isAdmin('ann sudo docker', 'linux'), true);
  assert.equal(isAdmin('ann wheel', 'linux'), true);
  assert.equal(isAdmin('ann adm users', 'linux'), false, 'adm only reads logs');
  assert.equal(isAdmin('ann administrators', 'linux'), false, 'a group is matched whole');
  assert.equal(isAdmin('ann sudo', 'darwin'), false);
  assert.equal(isAdmin('', 'linux'), false);
});

test('the login shell’s PATH is what stands between the markers, whatever the profile prints', () => {
  const noisy = 'Last login: Tue\nWelcome to nvm!\n__webchat_path__/opt/homebrew/bin:/usr/bin__webchat_path__\n';
  assert.equal(pathFrom(noisy), '/opt/homebrew/bin:/usr/bin');
  assert.equal(pathFrom('no markers here'), '');
  assert.equal(pathFrom('__webchat_path__/cut off'), '', 'a shell that died halfway tells nothing');
});

test('the service’s PATH ends with the installers’ folder, once', () => {
  assert.equal(servicePath('/usr/bin:/bin', '/home/ann'), '/usr/bin:/bin:/home/ann/.local/bin');
  assert.equal(servicePath('/home/ann/.local/bin:/usr/bin::', '/home/ann'), '/home/ann/.local/bin:/usr/bin');
});

test('a LaunchAgent runs the runner at login and again after it exits, with the saved PATH, and escapes what XML reserves', async () => {
  const plist = launchdPlist('/Users/ann/.local/bin/webchat-agent', '/a&b:/usr/bin', '/Users/ann/.webchat/agent.log');
  assert.match(plist, /<string>\/Users\/ann\/\.local\/bin\/webchat-agent<\/string>\s*<string>runner<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>\s*<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/a&amp;b:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/ann\/\.webchat\/agent\.log<\/string>/);
  // macOS has the real parser: a program path with markup in it must still load.
  if (process.platform !== 'darwin') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-plist-'));
  try {
    const file = path.join(dir, 'webchat-agent.plist');
    await fs.writeFile(file, launchdPlist('/Users/a<b>&c/webchat-agent', '/a&b:/usr/bin', '/tmp/x.log'));
    await promisify(execFile)('plutil', ['-lint', file]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a systemd unit quotes its program and PATH, escapes % everywhere and $ where a line expands variables', () => {
  const unit = systemdUnit('/home/a b/100%/we"ird$dir/webchat-agent', '/home/a b/bin:/100%:/q"uote:/$HOME');
  assert.match(unit, /^ExecStart="\/home\/a b\/100%%\/we\\"ird\$\$dir\/webchat-agent" runner$/m);
  // Environment= expands nothing, so `$` stays as it is.
  assert.match(unit, /^Environment="PATH=\/home\/a b\/bin:\/100%%:\/q\\"uote:\/\$HOME"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('setup names what it installs, and asks sudo only for packages', () => {
  assert.deepEqual(installSteps(['git', 'bubblewrap', 'socat', 'claude'], 'linux', 'apt-get'), [
    {
      say: 'install git, bubblewrap, and socat with apt-get: it asks for your password',
      commands: [['sudo', 'apt-get', 'update'], ['sudo', 'apt-get', 'install', '-y', 'git', 'bubblewrap', 'socat']],
    },
    { say: 'install Claude Code with its own installer: curl -fsSL https://claude.ai/install.sh | bash', commands: [['sh', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']] },
  ]);
  assert.deepEqual(installSteps(['socat'], 'linux', 'dnf').map((step) => step.commands), [[['sudo', 'dnf', 'install', '-y', 'socat']]]);
  // macOS has git from Apple's installer, which needs no sudo from here.
  assert.deepEqual(installSteps(['git'], 'darwin', '').map((step) => step.commands), [[['xcode-select', '--install']]]);
  assert.deepEqual(installSteps([], 'linux', 'apt-get'), []);
});

test('an idle agent checks in every minute only once an hour passed with nothing to do', () => {
  assert.equal(checkInEvery(0), 15_000);
  assert.equal(checkInEvery(59 * 60_000 + 59_000), 15_000);
  assert.equal(checkInEvery(60 * 60_000), 60_000);
  assert.equal(checkInEvery(5 * 60 * 60_000), 60_000);
});
