// The browser a run checks its work in (R-046): the proxy that lets Chrome reach only the run's own
// dev server, the sandbox that dev server runs in, and the rules for the browser's tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { LocalBench } from '../agent/bench.ts';
import { Lab } from '../agent/browser.ts';
import { claudeAsk } from '../agent/claude.ts';
import type { Harness } from '../agent/harness.ts';
import { judge, type Rules } from '../agent/rulebook.ts';
import { Quiet } from '../agent/runner.ts';

const darwin = { skip: process.platform !== 'darwin' && 'the lab runs on macOS only' };

/** What a server on 127.0.0.1 answers, outside any sandbox: the test's stand-in for another project's server. */
async function serve(port = 0) {
  const server = http.createServer((req, res) => res.end(`served ${req.headers.host}`));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

/** Sends one request line to the proxy, and returns its status line and body. */
function viaProxy(proxy: number, head: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(proxy, '127.0.0.1', () => socket.write(head));
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      // A tunnel stays open: its status line is the answer.
      if (/^HTTP\/1\.1 200 Connection/.test(text)) socket.destroy();
    });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

describe('the lab of a run that browses (R-046)', darwin, () => {
  let root: string;
  let work: string;
  let keys: string;
  let lab: Lab;
  let own: http.Server;
  let other: http.Server;
  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-lab-')));
    work = path.join(root, 'work');
    keys = path.join(root, 'keys');
    await fs.mkdir(work);
    await fs.mkdir(keys);
    await fs.writeFile(path.join(keys, 'account.json'), 'secret');
    await fs.writeFile(path.join(root, 'elsewhere.txt'), 'the owner\'s');
    lab = (await Lab.open([keys]))!;
    own = await serve(lab.ports[0]);
    other = await serve();
  });
  after(async () => {
    await lab.close();
    own.close();
    other.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('its proxy passes a run port on any localhost name, and refuses another host and another port', async () => {
    const port = lab.ports[0];
    const otherPort = (other.address() as AddressInfo).port;
    assert.match(await viaProxy(lab.proxy, `GET http://alice.localhost:${port}/ HTTP/1.1\r\nHost: alice.localhost:${port}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200[\s\S]*served alice\.localhost/);
    assert.match(await viaProxy(lab.proxy, `CONNECT bob.localhost:${port} HTTP/1.1\r\nHost: bob.localhost:${port}\r\n\r\n`), /^HTTP\/1\.1 200 Connection/);
    for (const target of [`example.com:${port}`, `localhost:${otherPort}`, `127.0.0.2:${port}`, `localhost.:${port}`]) {
      assert.match(await viaProxy(lab.proxy, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /^HTTP\/1\.1 403/, target);
      assert.match(await viaProxy(lab.proxy, `GET http://${target}/ HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403/, target);
    }
  });

  test('its dev server binds and reaches only the run ports, writes only the folder, and reads no secret', async () => {
    own.close();
    const probe = path.join(work, 'probe.mjs');
    const otherPort = (other.address() as AddressInfo).port;
    await fs.writeFile(
      probe,
      `import fs from 'node:fs'; import net from 'node:net';
const tryIt = (name, fn) => { try { fn(); console.log(name, 'ok'); } catch (e) { console.log(name, e.code); } };
const connect = (port, host = '127.0.0.1') => new Promise((r) => net.connect(port, host).once('connect', () => r('ok')).once('error', (e) => r(e.code)));
const listen = (port) => new Promise((r) => net.createServer().once('error', (e) => r(e.code)).listen(port, '127.0.0.1', () => r('ok')));
tryIt('write here', () => fs.writeFileSync('here.txt', '1'));
tryIt('write outside', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'outside.txt'))}, '1'));
tryIt('read secret', () => fs.readFileSync(${JSON.stringify(path.join(keys, 'account.json'))}));
tryIt('read here', () => fs.readFileSync('probe.mjs'));
tryIt('read outside', () => fs.readFileSync(${JSON.stringify(path.join(root, 'elsewhere.txt'))}));
tryIt('list home', () => fs.readdirSync(${JSON.stringify(os.homedir())}));
console.log('other port', await connect(${otherPort}));
console.log('bind other', await listen(${otherPort + 1}));
console.log('the internet', await connect(443, '1.1.1.1'));
net.createServer((c) => c.on('error', () => undefined).end('dev')).listen(process.env.PORT, '127.0.0.1');
`,
    );
    const said = await lab.start(`"${process.execPath}" probe.mjs`, work);
    assert.match(said, /PORT=\d+/);
    assert.match(said, /write here ok/);
    assert.match(said, /write outside EPERM/);
    assert.match(said, /read secret EPERM/);
    // Reads stop at the working folders, as the shell's do, or the tool's output would carry the owner's files.
    assert.match(said, /read here ok/);
    assert.match(said, /read outside EPERM/);
    assert.match(said, /list home EPERM/);
    assert.match(said, /other port EPERM/);
    assert.match(said, /bind other EPERM/);
    assert.match(said, /the internet EPERM/);
    await assert.rejects(fs.access(path.join(root, 'outside.txt')));
    lab.stop();
  });
});

describe('the rules for the browser (R-046)', () => {
  let root: string;
  let rules: Rules;
  before(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-browser-rules-')));
    await fs.mkdir(path.join(root, 'work'));
    rules = { folders: [path.join(root, 'work')], secrets: [], tools: ['dev_server'], ports: [4100, 4101] };
  });
  after(() => fs.rm(root, { recursive: true, force: true }));
  const ask = (tool: string, input: Record<string, unknown>) => judge(claudeAsk({ tool_name: `mcp__browser__${tool}`, input }, path.join(root, 'work')), rules);

  test('lets a page of the run open, on a localhost name and a run port', () => {
    for (const url of ['http://localhost:4100/', 'http://alice.localhost:4101/chat', 'http://127.0.0.1:4100', 'http://[::1]:4100/', 'about:blank'])
      assert.deepEqual(ask('new_page', { url }), { allow: true }, url);
    assert.deepEqual(ask('take_screenshot', { pageId: 1, filePath: 'shots/desktop.png' }), { allow: true });
  });

  test('refuses a file: URL, another host or port, a path outside the folder and a tool off the list', () => {
    for (const url of ['file:///etc/passwd', 'http://example.com:4100/', 'http://localhost:5432/', 'http://localhost/', 'view-source:http://localhost:4100/', 'javascript:alert(1)'])
      assert.equal(ask('navigate_page', { pageId: 1, type: 'url', url }).allow, false, url);
    assert.equal(ask('take_screenshot', { pageId: 1, filePath: path.join(root, 'out.png') }).allow, false);
    assert.equal(ask('upload_file', { pageId: 1, uid: '1', filePaths: ['ok.txt', '../../etc/hosts'] }).allow, false);
    assert.equal(ask('evaluate_script', { pageId: 1, sourcePath: path.join(os.homedir(), '.ssh', 'id_rsa') }).allow, false);
    for (const tool of ['install_extension', 'lighthouse_audit', 'performance_start_trace', 'take_heapsnapshot', 'some_new_tool']) assert.equal(ask(tool, { pageId: 1 }).allow, false, tool);
    assert.equal(judge(claudeAsk({ tool_name: 'mcp__browser__new_page', input: { url: 'http://localhost:4100/' } }, root), { ...rules, ports: undefined }).allow, false, 'a run with no lab has no browser');
  });

  test('lets an allowed browser call and the dev server tool through without asking the owner', async () => {
    const work = path.join(root, 'work');
    const asked: string[] = [];
    const harness = {
      name: 'Fake',
      secrets: [],
      turn: async (turn: Parameters<Harness['turn']>[0]) =>
        Promise.all(
          [
            { tool_name: 'mcp__browser__new_page', input: { url: `http://alice.localhost:${turn.lab?.ports[0]}/` } },
            { tool_name: 'mcp__webchat__dev_server', input: { command: 'npm run dev' } },
            { tool_name: 'mcp__browser__install_extension', input: { path: 'ext' } },
          ].map((call) => turn.ask!(claudeAsk(call, turn.cwd))),
        ),
      offers: () => ({ knobs: [] }),
      apply: async () => undefined,
    } as unknown as Harness;
    const bench = new LocalBench([harness], undefined, path.join(root, 'keys'));
    const { answer } = await bench.turn(
      { harness: 'Fake', cwd: work, session: 's', resume: false, message: '', schema: {}, schemas: [], setup: { claudeMd: false, skills: [], noAttribution: false } },
      { signal: new AbortController().signal, permit: () => ({ ask: async (action) => (asked.push(action.detail), { allow: true }), quiet: new Quiet(), done: () => undefined }) },
    );
    await bench.end();
    const replies = answer as Array<{ allow: boolean }>;
    if (process.platform !== 'darwin') return assert.deepEqual(replies.map((r) => r.allow), [false, false, false]);
    assert.deepEqual(replies.map((r) => r.allow), [true, true, false]);
    assert.deepEqual(asked, [], 'the owner is asked nothing');
  });
});
