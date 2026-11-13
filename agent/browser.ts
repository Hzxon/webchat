// The browser a run checks its work in (R-046, docs/decisions/new-dev-server-sandbox.md). A session
// whose harness browses gets a lab: two free ports, the run's dev server on them, and a proxy that
// Chrome sends every request through, which passes only those ports on `localhost` names. The
// model asks for the dev server with WebChat's `dev_server` tool, and the runner starts it under a
// Seatbelt profile of its own, since it is the model's code: it writes only the working folder and
// the lab's temp folder, binds and reaches only the two ports, and reads no secret folder. The
// browser is `chrome-devtools-mcp`, pinned below; setup installs it, and a run never fetches it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { isCredential } from './harness.ts';
import { layoutFor } from './lockroom.ts';
import { onRunPort, real } from './rulebook.ts';

/** Update the version and the sum together, from `npm view chrome-devtools-mcp@<version> dist.tarball` and the tarball's SHA-256, and the exact version in package.json. */
export const BROWSER_VERSION = '1.13.0';
export const BROWSER_ASSET = {
  name: `chrome-devtools-mcp-${BROWSER_VERSION}.tgz`,
  url: `https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-${BROWSER_VERSION}.tgz`,
  sha256: '9158c4b4a8792cb522ae46f76eeaa9491ce04616a3ae97229a16277e02a4aea4',
};

const BIN = path.join('out', 'Default', 'gen', 'src', 'bin', 'chrome-devtools-mcp.js');

/** The package: root-owned in the program's folder, where setup put it, or in node_modules when working on WebChat. */
export const browserDir = () => (isSea() ? path.join(layoutFor(process.platform === 'darwin' ? 'darwin' : 'linux').programDir, 'chrome-devtools-mcp') : path.join(import.meta.dirname, '..', 'node_modules', 'chrome-devtools-mcp'));

/** `webchat-agent browser`: the single file runs the package, which it cannot `import()` itself, through code the main context's loader compiles. */
export async function runBrowser(args: string[]) {
  const entry = path.join(browserDir(), BIN);
  process.argv = [process.argv[0]!, entry, ...args];
  const load = new vm.Script('(url) => import(url)', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInThisContext() as (url: string) => Promise<unknown>;
  await load(pathToFileURL(entry).href);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** Whether something listens on a port, on either loopback address. */
const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, 'localhost', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
  });

const REFUSED = 'WebChat’s proxy passes only this run’s dev server.';

/**
 * The proxy Chrome goes through: CONNECT and absolute-form HTTP, only where `onRunPort` allows. It
 * connects to `localhost` itself, which reaches the port on either loopback address.
 */
function proxy(ports: number[]) {
  const server = http.createServer((req, res) => {
    const url = URL.parse(req.url ?? '');
    if (!url || url.protocol !== 'http:' || !onRunPort(url.href, ports)) return void res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(REFUSED);
    const upstream = http.request({ host: 'localhost', port: url.port, method: req.method, path: url.pathname + url.search, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });
  // Chrome tunnels https and WebSockets, a dev server's live reload among them.
  server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => undefined);
    const url = URL.parse(`http://${req.url}`);
    if (!url || !onRunPort(url.href, ports)) return void socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${REFUSED}`);
    const upstream = net.connect(Number(url.port), 'localhost', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return server;
}

/**
 * The Seatbelt profile of a dev server: no network but its ports, so no other loopback port or
 * socket of the laptop, no DNS and no internet; writes only in `writable`; no secret folder; no
 * Mach service, which would let it open a URL in another app; no signal outside the sandbox.
 */
export function devProfile({ ports, writable, secrets }: { ports: number[]; writable: string[]; secrets: string[] }) {
  const paths = (dirs: string[]) => dirs.map((dir) => `(subpath ${JSON.stringify(real(dir))})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    ...ports.map((port) => `(allow network-bind network-inbound (local ip "localhost:${port}"))`),
    ...ports.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    // Sockets of its own, such as tsx's IPC in its temp folder, where nothing else of the laptop listens.
    // One rule a folder: the filter takes one path.
    ...writable.map((dir) => `(allow network* (local unix-socket ${paths([dir])}) (remote unix-socket ${paths([dir])}))`),
    '(deny file-write*)',
    `(allow file-write* ${paths(writable)} (literal "/dev/null") (literal "/dev/tty"))`,
    ...(secrets.length ? [`(deny file-read* ${paths(secrets)})`] : []),
    '(deny mach-lookup)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
  ].join('\n');
}

/** How long the tool waits for the dev server to answer on a port. */
const START_MS = 120_000;
/** How much of its output the tool returns. */
const TAIL = 4000;

export class Lab {
  private dev?: ChildProcess;

  private constructor(
    /** The two ports the dev server may bind, as `PORT` and `PORT_2`. */
    readonly ports: number[],
    private readonly server: http.Server,
    private readonly tmp: string,
    private readonly secrets: string[],
  ) {}

  /** A lab where it can run: on macOS, with the pinned package installed. */
  static async open(secrets: string[]) {
    if (process.platform !== 'darwin' || !existsSync(path.join(browserDir(), BIN))) return undefined;
    const ports = [await freePort(), await freePort()];
    const server = proxy(ports);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // Its real path: Seatbelt matches a socket's path as the program names it, and macOS's temp folder is behind a link.
    return new Lab(ports, server, await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-lab-'))), secrets);
  }

  /** The proxy's port. */
  get proxy() {
    return (this.server.address() as AddressInfo).port;
  }

  /** The browser's MCP server for a process in `cwd`: headless on a temporary profile, every request through the proxy, nothing sent to Google. */
  mcpServer(cwd: string) {
    const [command, ...args] = isSea() ? [process.execPath, 'browser'] : [process.execPath, path.join(browserDir(), BIN)];
    const chrome = [
      // Loopback goes through the proxy too, which Chrome otherwise skips.
      '--proxy-bypass-list=<-loopback>',
      // WebRTC's UDP would skip a proxy, and so would a name looked up on its own; the rule covers the proxy's own address unless excluded.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-quic',
    ];
    return {
      type: 'stdio',
      command,
      args: [...args, '--headless', '--isolated', '--viewport=1280x800', '--no-usage-statistics', '--no-performance-crux', '--no-file-navigations', '--no-category-performance', '--no-category-memory', `--filesystemRoot=${cwd}`, `--proxyServer=http://127.0.0.1:${this.proxy}`, ...chrome.map((arg) => `--chromeArg=${arg}`)],
      env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1' },
    };
  }

  /** Starts `command` as the dev server, ending the one before, and says, for the model, how it went and where to open it. */
  async start(command: string, cwd: string) {
    this.stop();
    const [port, port2] = this.ports as [number, number];
    const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry) => !isCredential(entry))), PORT: String(port), PORT_2: String(port2), TMPDIR: this.tmp, npm_config_cache: path.join(this.tmp, 'npm'), BROWSER: 'none' };
    const profile = devProfile({ ports: this.ports, writable: [cwd, this.tmp], secrets: this.secrets });
    const child = (this.dev = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let output = '';
    const take = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-TAIL));
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    let code: number | null | undefined;
    child.on('close', (exit) => (code = exit));
    let open: number | undefined;
    for (const deadline = Date.now() + START_MS; open === undefined && code === undefined && Date.now() < deadline; await sleep(250)) {
      const up = await Promise.all(this.ports.map(answers));
      open = this.ports.find((_, i) => up[i]);
    }
    const status =
      open !== undefined ? `answers on port ${open}` : code !== undefined ? `exited with code ${code} before it answered on a port` : `has not answered on either port in ${START_MS / 60_000} minutes, and still runs`;
    const where = `It runs in WebChat’s sandbox with PORT=${port} and PORT_2=${port2}: it can bind and reach only those two ports and writes only this folder, and it ends with this turn. Open it in the browser at http://localhost:<port>/, or as two people at http://alice.localhost:<port>/ and http://bob.localhost:<port>/, since each host keeps its own cookies.`;
    const said = output.trim() ? `\n\nIts output so far:\n${output.trim()}` : '';
    return `\`${command}\` ${status}. ${where}${said}`;
  }

  /** Ends the dev server and whatever it started. */
  stop() {
    // The group, since a shell that ended may leave what it started.
    if (this.dev?.pid) {
      try {
        process.kill(-this.dev.pid, 'SIGKILL');
      } catch {
        // It ended, all of it.
      }
    }
    this.dev = undefined;
  }

  async close() {
    this.stop();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    await fs.rm(this.tmp, { recursive: true, force: true });
  }
}
