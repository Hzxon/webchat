import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { claudeHarness, claudeSettings, pathDirs, restrictedSettings, sandboxProblem } from '../agent/claude.ts';
import { AgentClient } from '../agent/client.ts';
import { layoutFor, programOf, updateConfigOf, type Cmd } from '../agent/lockroom.ts';
import { doctor, linksFrom, pairInto, setup, uninstall } from '../agent/setup.ts';
import { harnessFinder, supported, supportedList } from '../agent/harnesses.ts';
import { versionAtLeast } from '../agent/harness.ts';
import { newPairingCode } from '../shared/e2ee.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './fakes.ts';
import { sh, FAKE_GH, withEnv, setEnv, approve, fakeLaptop } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function setupTests(w: World) {
  test('sets an agent up with one command: builds its room, pairs it as the role account, installs the runner’s login service, replaces it on a second run, and removes it (docs/roadmap/new-agent-setup.md)', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(w.home, 'setup-'));
    const { bin, laptopHome, agentHome, log, restore, program, layout, room, unitFile } = await fakeLaptop(dir);
    const said: string[] = [];
    const print = console.log;
    console.log = (...words: unknown[]) => void said.push(words.join(' '));
    const asked: string[] = [];
    const account = path.join(layout.data, 'laptop', 'account.json');
    // The role account's `pair` is setup's own function, with the code from stdin.
    room.onPair = ({ code, picks }) => pairInto(account, code, picks as Parameters<typeof pairInto>[2]);
    const options = { home: agentHome, program, layout, root: room.root, read: room.read, ghArchive: async () => Buffer.from('archive'), browserArchive: async () => Buffer.from('package'), ask: async (question: string) => (asked.push(question), 'y') };
    const commands = async () => (await fs.readFile(log, 'utf8')).trim().split('\n');
    try {
      // Not an administrator: it says so alone, asks nothing and changes nothing.
      process.env.FAKE_GROUPS = 'staff';
      await assert.rejects(setup(`${w.baseUrl}#${newPairingCode()}`, options), /Nothing was changed/);
      // Only the read-only check that `systemctl --user` runs, on Linux, reaches the services.
      const ran = existsSync(log) ? (await commands()).filter((line) => line !== 'systemctl --user show-environment') : [];
      assert.deepEqual([asked.length, existsSync(unitFile), ran, said.filter((line) => /Administrator/.test(line)).length, room.log.length, existsSync(layout.data), existsSync(layout.programDir)], [0, false, [], 1, 0, false, false]);
      process.env.FAKE_GROUPS = 'staff admin sudo';

      const code = newPairingCode();
      const [agent] = await Promise.all([approve(w.alice, code, 'Laptop'), setup(`${w.baseUrl}#${code}`, options)]);
      assert.match(asked[0]!, /pair with .* you approve the agent in WebChat[\s\S]*login service[\s\S]*changes no security setting/);
      assert.match(asked[0]!, /\[x\] Claude Code 2\.1\.300, signed in\n {2}\[x\] Codex 0\.58\.0, signed in/, 'both are ticked: found and signed in');
      assert.ok(said.some((line) => /^ {2}ok {2,}Claude Code 2\.1\.300, signed in: found, not linked\.$/.test(line)), said.join('\n'));
      assert.ok(said.includes('Paired with Alice.'));
      // The account is in the role account's folder, paired with the code on stdin and never in an argument; the runner's service runs the installed program, with the login shell's PATH.
      const saved = JSON.parse(await fs.readFile(account, 'utf8')) as { userId: number; owner: number; picked: string[] };
      assert.deepEqual([saved.userId, saved.owner, saved.picked], [agent.id, w.alice.id, ['Claude Code', 'Codex']]);
      assert.deepEqual(room.log.filter((cmd) => cmd.argv.at(-1) === 'pair').map((cmd) => [cmd.as, cmd.argv.some((word) => word.includes(code))]), [[layout.user, false]]);
      assert.equal(await fs.readFile(programOf(layout), 'utf8'), 'the program');
      assert.equal(await fs.readFile(path.join(layout.programDir, 'bin', 'gh'), 'utf8'), 'archive');
      assert.equal(await fs.readFile(path.join(layout.programDir, 'chrome-devtools-mcp', 'package.json'), 'utf8'), 'package', 'the browser’s pinned package (R-046)');
      const unit = await fs.readFile(unitFile, 'utf8');
      assert.ok(unit.includes(`${programOf(layout)}`) && unit.includes(bin) && /runner/.test(unit), unit);
      assert.equal(await fs.readlink(path.join(laptopHome, '.local', 'bin', 'webchat-agent')), programOf(layout));
      const first = await commands();
      assert.ok(first.some((line) => (process.platform === 'darwin' ? line.startsWith(`launchctl bootstrap gui/${process.getuid!()} ${unitFile}`) : line === 'systemctl --user restart webchat-agent')), first.join('\n'));

      // The updater: stopped before the program is built over, installed after the keyholder's service, with the paired server in the settings only root writes.
      const at = (match: (cmd: Cmd) => boolean) => room.log.findIndex(match);
      const stop = at((cmd) => cmd.soft === true && cmd.argv.some((word) => word.includes(layout.updaterLabel)));
      assert.ok(stop >= 0 && stop < at((cmd) => cmd.argv.at(-1) === programOf(layout)), 'stopped first');
      assert.ok(at((cmd) => cmd.argv.at(-1) === layout.unit) < at((cmd) => cmd.argv.at(-1) === layout.updaterUnit), 'installed after the keyholder');
      assert.equal(JSON.parse(await fs.readFile(updateConfigOf(layout), 'utf8')).server, w.baseUrl);
      assert.match(await fs.readFile(layout.updaterUnit, 'utf8'), /update/);

      // A second run, with no code, pairs nothing again and replaces the service.
      room.system.made = true;
      said.length = 0;
      await setup(undefined, options);
      assert.equal(asked.length, 2);
      assert.doesNotMatch(asked[1]!, /pair with|to link/);
      assert.ok(!said.includes('Approve the agent in WebChat, in the window that shows the code.'));
      assert.ok((await commands()).length > first.length);

      // A run that fails after it stopped the updater starts it again, so the agent still follows the server's release.
      const before = room.log.length;
      await assert.rejects(setup(undefined, { ...options, ghArchive: async () => Promise.reject(new Error('offline')) }), /offline/);
      const failed = room.log.slice(before);
      const stopped = failed.findIndex((cmd) => cmd.soft === true && cmd.argv.some((word) => word.includes(layout.updaterLabel)));
      assert.ok(stopped >= 0 && failed.findIndex((cmd, i) => i > stopped && cmd.argv.at(-1) === layout.updaterUnit) > stopped, 'started again');

      // Declined, uninstall removes nothing; agreed, it leaves no service, no folder and no account.
      const gone = { layout, root: room.root, read: room.read };
      await assert.rejects(uninstall(agentHome, async () => false, gone), /Nothing was removed/);
      assert.equal(existsSync(unitFile), true);
      await uninstall(agentHome, async () => true, gone);
      assert.deepEqual([unitFile, layout.data, layout.ipc, layout.programDir, layout.unit, layout.updaterUnit, path.join(laptopHome, '.local', 'bin', 'webchat-agent')].map((file) => existsSync(file)), [false, false, false, false, false, false, false]);
      assert.equal(room.system.made, false);
      assert.match((await commands()).at(-1) ?? '', process.platform === 'darwin' ? /^launchctl bootout|^launchctl bootstrap/ : /^systemctl --user daemon-reload/);
    } finally {
      console.log = print;
      restore();
    }
  });

  test('moves a plugin’s or the daemon’s account into the keyholder’s folder without pairing again: the newer cursor wins, and a live Claude Code window stops it (docs/decisions/locked-room.md)', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(w.home, 'move-'));
    const { laptopHome, agentHome, restore, program, layout, room } = await fakeLaptop(dir);
    const [plugin, daemon] = [path.join(laptopHome, '.claude', 'plugins', 'data', 'webchat-webchat'), path.join(agentHome, 'laptop')];
    const restoreClaude = setEnv({ CLAUDE_CONFIG_DIR: path.join(laptopHome, '.claude') });
    const print = console.log;
    console.log = () => undefined;
    const pairings = async () => (await w.instance.sql.query<{ n: string }>('SELECT count(*) AS n FROM webchat.pairings'))[0]!.n;
    const options = { home: agentHome, program, layout, root: room.root, read: room.read, ghArchive: async () => Buffer.from('archive'), browserArchive: async () => Buffer.from('package'), ask: async () => 'y' };
    const setupOf = (from: string) => JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, linked: [] }, from });
    const kept = (...parts: string[]) => fs.readFile(path.join(layout.data, 'laptop', ...parts), 'utf8').catch(() => undefined);
    try {
      // A plugin's account, paired for real, and an older copy of it as the daemon kept it.
      await fs.mkdir(path.join(plugin, 'laptop'), { recursive: true });
      const code = newPairingCode();
      await Promise.all([approve(w.alice, code, 'Laptop'), AgentClient.pair(path.join(plugin, 'account.json'), w.baseUrl, code)]);
      const file = JSON.parse(await fs.readFile(path.join(plugin, 'account.json'), 'utf8')) as { cursor: number; userId: number };
      await fs.mkdir(path.join(daemon, 'laptop'), { recursive: true });
      await fs.writeFile(path.join(daemon, 'account.json'), JSON.stringify({ ...file, cursor: file.cursor - 1 }));
      await fs.writeFile(path.join(daemon, 'laptop', 'setup.json'), setupOf('daemon'));
      await fs.writeFile(path.join(plugin, 'laptop', 'setup.json'), setupOf('plugin'));
      await fs.writeFile(path.join(plugin, 'codex-threads.json'), 'threads');
      await fs.mkdir(path.join(plugin, 'repos', 'acme__app'), { recursive: true });
      await fs.writeFile(path.join(plugin, 'repos', 'acme__app', 'connected'), '/work/app');
      await fs.writeFile(path.join(plugin, 'laptop', 'claude.json'), 'settings');
      const before = await pairings();

      // A Claude Code window that holds the plugin's lock stops setup before it changes anything.
      await fs.writeFile(path.join(plugin, 'watch.lock'), String(process.pid));
      await assert.rejects(setup(undefined, options), /Nothing was changed/);
      assert.deepEqual([room.log.length, existsSync(layout.data)], [0, false]);
      await fs.rm(path.join(plugin, 'watch.lock'));

      await setup(undefined, options);
      // The plugin's account, the one that saw more, is in the keyholder's folder as it was: the same agent and cursor, with no new pairing.
      const moved = JSON.parse((await kept('account.json'))!) as { cursor: number; userId: number };
      assert.deepEqual([moved.cursor, moved.userId, await pairings()], [file.cursor, file.userId, before]);
      assert.deepEqual([await kept('laptop', 'setup.json'), await kept('repos', 'acme__app', 'connected'), await kept('laptop', 'claude.json')], [setupOf('plugin'), '/work/app', undefined]);
      assert.equal(await fs.readFile(path.join(agentHome, 'runner', 'codex-threads.json'), 'utf8'), 'threads', 'the runner keeps its own files');
      // Once the keyholder took it, the plugin's copy is gone and the daemon's older one is left, which the owner can delete.
      assert.deepEqual([existsSync(path.join(plugin, 'account.json')), existsSync(path.join(plugin, 'repos', 'acme__app', 'connected')), existsSync(path.join(daemon, 'account.json'))], [false, false, true]);
      // The account went in as the role account, through stdin, in a folder only it reads.
      const writes = room.log.filter((cmd) => cmd.as === layout.user && cmd.stdin);
      assert.ok(writes.length >= 3 && writes.every((cmd) => cmd.argv[2]!.includes('umask 077')));
    } finally {
      console.log = print;
      restoreClaude();
      restore();
    }
  });

  test('finds the supported harnesses on the PATH and in the usual folders, and names each row for doctor', { timeout: 30_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(w.home, 'finder-'));
    const [bin, userHome, agentHome] = ['bin', 'home', 'home/.webchat'].map((name) => path.join(dir, name));
    await fs.mkdir(bin);
    await fs.mkdir(path.join(userHome, '.local', 'bin'), { recursive: true });
    const fake = (where: string, name: string, body: string) => fs.writeFile(path.join(where, name), body, { mode: 0o755 });
    await fake(bin, 'claude', FAKE_CLAUDE);
    await fake(bin, 'shell', `#!/bin/sh\nprintf '%s%s%s' __webchat_path__ "$PATH" __webchat_path__\n`);
    await fake(bin, 'id', '#!/bin/sh\necho admin sudo\n');
    await fake(bin, 'gh', FAKE_GH);
    await fs.writeFile(path.join(dir, 'gh.json'), JSON.stringify({ pulls: [] }));
    // A PATH of its own, with node for the shims and none of the real harnesses this machine may have.
    await fs.mkdir(path.join(dir, 'tools'));
    await fs.symlink(process.execPath, path.join(dir, 'tools', 'node'));
    const restore = setEnv({ HOME: userHome, SHELL: path.join(bin, 'shell'), PATH: ['relative-bin', bin, path.join(dir, 'tools'), '/usr/bin', '/bin'].join(path.delimiter), FAKE_GH_STATE: path.join(dir, 'gh.json') });
    const print = console.log;
    const said: string[] = [];
    try {
      assert.deepEqual(pathDirs().slice(0, 1), [bin], 'a relative PATH entry is no place to look: the model writes the worktree');
      const find = harnessFinder({ dataDir: agentHome });
      const where = async () => Promise.all((await find()).map(async (h) => (await h.found()).path));
      const [claude, codex] = await find();
      assert.deepEqual(await where(), [path.join(bin, 'claude'), undefined, undefined, undefined], 'Codex, Hermes and Antigravity are not found, and still listed');
      assert.equal(await codex!.refusal(), 'I cannot find Codex on this laptop.');
      // Installed later, in a folder the installers use, it shows at the next look, and the adapter before it stays.
      await fake(path.join(userHome, '.local', 'bin'), 'codex', FAKE_CODEX);
      assert.deepEqual(await where(), [path.join(bin, 'claude'), path.join(userHome, '.local', 'bin', 'codex'), undefined, undefined]);
      assert.equal((await find())[0], claude, 'an unchanged program keeps its adapter');
      await fs.utimes(path.join(bin, 'claude'), new Date(), new Date(Date.now() + 5000));
      assert.notEqual((await find())[0], claude, 'an updated one gets a new adapter');
      assert.deepEqual([supported('Claude Code')?.id, supported('CODEX')?.id, supported('hermes')?.id, supported('gemini')], ['claude', 'codex', 'hermes', undefined]);
      assert.equal(supportedList(), 'claude (Claude Code), codex (Codex), hermes (Hermes), antigravity (Antigravity)');
      await assert.rejects(sh(process.execPath, ['--import', 'tsx', 'agent/index.ts', 'link', 'gemini']), (error: { code: number; stderr: string }) => error.code === 1 && /^'gemini' is not a harness WebChat supports\. Supported: claude \(Claude Code\), codex \(Codex\), hermes \(Hermes\), antigravity \(Antigravity\)\./.test(error.stderr));

      assert.equal(await claudeHarness(path.join(bin, 'claude'), agentHome).refusal(), undefined);
      await withEnv({ FAKE_CLAUDE_VERSION: '2.1.258' }, async () => assert.equal(await claudeHarness(path.join(bin, 'claude'), agentHome).refusal(), 'Claude Code 2.1.258 is older than 2.1.259, which I need. Update it.'));
      for (const [found, min, ok] of [['2.1.259', '2.1.259', true], ['2.1.260', '2.1.259', true], ['2.2.0', '2.1.259', true], ['3', '2.1.259', true], ['2.1.258', '2.1.259', false], ['2.0.999', '2.1.259', false], ['2.1.259-beta', '2.1.259', true], ['dev', '2.1.259', true], [undefined, '2.1.259', true]] as const) {
        assert.equal(versionAtLeast(found, min), ok, `${found} against ${min}`);
      }

      // One doctor line per supported harness, for each state a row can be in (docs/decisions/harness-linking.md).
      console.log = (...words: unknown[]) => void said.push(words.join(' '));
      // A keyholder installed on this machine would answer on the default socket, and its linked list wins over setup.json.
      const noRoom = { ...layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux'), ipc: path.join(dir, 'no-ipc') };
      const doctorSays = async (linked: string[], env: Record<string, string> = {}) => {
        await fs.mkdir(path.join(agentHome, 'laptop', 'laptop'), { recursive: true });
        await fs.writeFile(path.join(agentHome, 'laptop', 'laptop', 'setup.json'), JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, linked } }));
        said.length = 0;
        await withEnv(env, () => doctor(agentHome, noRoom));
        process.exitCode = 0;
        return said.filter((line) => /^ {2}\w+ {2,}(Claude Code|Codex)/.test(line)).map((line) => line.replace(/^ {2}\w+ {2,}/, ''));
      };
      assert.deepEqual(await doctorSays(['Claude Code', 'Codex']), ['Claude Code 2.1.300, signed in: linked.', 'Codex 0.58.0, signed in: linked.']);
      assert.deepEqual(await doctorSays(['Claude Code']), ['Claude Code 2.1.300, signed in: linked.', 'Codex 0.58.0, signed in: found, not linked.']);
      assert.deepEqual((await doctorSays(['Codex'], { FAKE_CODEX_SIGNED_OUT: '1' }))[1], 'Codex 0.58.0: linked, needs attention.');
      assert.deepEqual((await doctorSays(['Claude Code'], { FAKE_CLAUDE_VERSION: '2.1.0' }))[0], 'Claude Code 2.1.0, signed in: linked, needs attention.');
      await fs.rm(path.join(userHome, '.local', 'bin', 'codex'));
      assert.deepEqual(await doctorSays(['Codex']), ['Claude Code 2.1.300, signed in: found, not linked.', 'Codex: linked, needs attention.']);
      assert.deepEqual(await doctorSays([]), ['Claude Code 2.1.300, signed in: found, not linked.', 'Codex: not installed.']);
    } finally {
      console.log = print;
      restore();
    }
  });

  test('reads setup\'s answer: yes takes the ticked harnesses, names take exactly those, and anything else stops it', () => {
    const found = [
      { id: 'claude', name: 'Claude Code', command: 'claude', program: '/bin/claude', signedIn: true },
      { id: 'codex', name: 'Codex', command: 'codex', program: '/bin/codex' },
    ];
    const names = (answer: string) => linksFrom(answer, found)?.map((f) => f.name);
    assert.deepEqual([names('y'), names('Yes'), names('none'), names('codex'), names('claude-code, codex'), names('codex codex')], [['Claude Code'], ['Claude Code'], [], ['Codex'], ['Claude Code', 'Codex'], ['Codex']]);
    assert.deepEqual([names(''), names('n'), names('hermes'), names('claude hermes')], [undefined, undefined, undefined, undefined]);
  });

  test('warns when a managed setting would let the shell read the secrets (R-030)', async () => {
    const dir = await fs.mkdtemp(path.join(w.home, 'sandbox-'));
    const data = path.join(dir, 'data');
    const project = path.join(dir, 'app');
    await fs.mkdir(path.join(project, '.claude'), { recursive: true });
    await fs.mkdir(data);
    // A background Claude reads only managed settings and the plugin's file, so the project cannot reopen the secrets (R-035).
    await fs.writeFile(path.join(project, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowRead: [data] } } }));
    const file = path.join(dir, 'claude.json');
    await fs.writeFile(file, JSON.stringify(claudeSettings({ secrets: [data], npmCache: path.join(dir, 'npm'), env: {} })));
    assert.equal(await sandboxProblem(project, [data], restrictedSettings(file)), undefined);
    // Its reads stop at the working directories, so only a folder inside them needs a rule of its own.
    assert.match((await sandboxProblem(project, [data, path.join(project, 'keys')], restrictedSettings(file))) ?? '', /could read/, 'a folder in the project the file leaves out');
    const off = path.join(dir, 'off.json');
    await fs.writeFile(off, '{}');
    assert.match((await sandboxProblem(project, [data], restrictedSettings(off))) ?? '', /turn its sandbox off/);
    // Where the sandbox cannot start, Claude Code would run the shell without it unless told to fail (K-53).
    const unsafe = path.join(dir, 'unsafe.json');
    await fs.writeFile(unsafe, JSON.stringify({ sandbox: { failIfUnavailable: false } }));
    assert.match((await sandboxProblem(project, [data], [[unsafe, dir], [file, dir]])) ?? '', /unsandboxed/);
    // Managed settings come first and can reopen a folder; the narrower rule decides, as in Claude Code.
    const managed = path.join(dir, 'managed.json');
    await fs.writeFile(managed, JSON.stringify({ sandbox: { filesystem: { allowRead: [path.join(data, 'keys')] } } }));
    assert.match((await sandboxProblem(project, [path.join(data, 'keys')], [[managed, dir], [file, dir]])) ?? '', /could read/, 'a narrower allow wins');
    // A command outside the sandbox is one the rulebook no longer asks the owner about.
    for (const sandbox of [{ allowUnsandboxedCommands: true }, { excludedCommands: ['docker'] }]) {
      await fs.writeFile(managed, JSON.stringify({ sandbox }));
      assert.match((await sandboxProblem(project, [data], [[managed, dir], [file, dir]])) ?? '', /outside its sandbox/);
    }
    // Its shell gets no variable that holds a credential, by its name or by a password in a URL.
    const env = { GH_TOKEN: 'x', DATABASE_URL: 'postgres://me:pw@db/app', SSH_AUTH_SOCK: '/tmp/agent', MY_VAR: 'ghp_abc', PATH: '/bin', HOME: '/home/me' };
    const denied = claudeSettings({ secrets: [], npmCache: '', env }).sandbox.credentials.envVars.map((v) => v.name);
    assert.deepEqual(denied, ['GH_TOKEN', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'MY_VAR']);
  });
}
