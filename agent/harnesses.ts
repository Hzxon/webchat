// The harnesses WebChat supports, and where a laptop has them (docs/decisions/harness-linking.md).
// Supported means a built-in adapter, Claude Code or Codex, or an ACP agent on the shipped list
// (acp-agents.ts). The owner links each one; nothing here links anything.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { acpHarness } from './acp.ts';
import { ACP_AGENTS, type AcpAgent } from './acp-agents.ts';
import { claudeHarness, onPath, pathDirs } from './claude.ts';
import { codexHarness } from './codex.ts';
import type { Harness } from './harness.ts';

/**
 * What an adapter needs of its host: the guard hook for Claude Code's turns, the plugin's folder,
 * and the argv that runs this program again, which an ACP agent starts as its answer server.
 */
interface Host {
  hook: string;
  dataDir: string;
  self?: string[];
}

/** The argv that runs this program again: the single file, or this script as node started it (D-097). */
const selfArgv = () => (isSea() ? [process.execPath] : [process.execPath, ...process.execArgv, process.argv[1] ?? '']);

interface Supported {
  /** What `webchat-agent link` takes. The owner's name for it, which `SetupChoice` and the pickers use, is the adapter's `name`. */
  id: string;
  name: string;
  command: string;
  build(program: string, host: Required<Host>): Harness;
}

export const acpRow = (agent: AcpAgent): Supported => ({
  id: agent.id,
  name: agent.name,
  command: agent.program,
  build: (program, { dataDir, self }) => acpHarness({ agent, program, self, dataDir }),
});

export const SUPPORTED: Supported[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', build: (program, { hook, dataDir }) => claudeHarness(program, hook, dataDir) },
  { id: 'codex', name: 'Codex', command: 'codex', build: (program, { dataDir }) => codexHarness(program, dataDir) },
  ...ACP_AGENTS.map(acpRow),
];

/** The supported harness a `link` argument names, by id or name in any letter case, or undefined. */
export const supported = (arg: string, kinds = SUPPORTED) => {
  const wanted = arg.toLowerCase().replace(/\s+/g, '-');
  return kinds.find((s) => wanted === s.id || wanted === s.name.toLowerCase().replace(/\s+/g, '-'));
};

export const supportedList = (kinds = SUPPORTED) => kinds.map((s) => `${s.id} (${s.name})`).join(', ');

/**
 * The folders in the home folder that the installers use, which a service's PATH may not list; the
 * newest nvm Node's `bin` too, where `npm install -g` puts a harness. The system folders, such as
 * Homebrew's, are on the login shell's PATH, which setup gives the service.
 */
async function usualFolders(home: string) {
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  const newest = (await fs.readdir(nvm).catch(() => [] as string[])).sort().at(-1);
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...(newest ? [path.join(nvm, newest, 'bin')] : []),
  ];
}

/**
 * The folders to look in: this process's PATH, which is the login shell's when it runs as the
 * service setup installs, then the usual install folders. Absolute only (D-097).
 */
export async function searchDirs(home = os.homedir()) {
  return [...new Set([...pathDirs(), ...(await usualFolders(home))])];
}

/**
 * Finds the supported harnesses again each call, and returns one adapter for each, in the order of
 * `SUPPORTED`, with no program for one the laptop lacks, so Settings can say so. An adapter stays
 * while its program and the program's mtime do, which keeps what it learned of its version; one
 * installed or updated since is built anew. `claude` is the session's own, which comes first.
 */
export function harnessFinder(host: Host, claude = '', kinds = SUPPORTED) {
  const full = { self: selfArgv(), ...host };
  const built = new Map<string, { key: string; harness: Harness }>();
  return () =>
    Promise.all(
      kinds.map(async (kind) => {
        const program = (kind.id === 'claude' && claude) || (await onPath(kind.command, await searchDirs()));
        const key = `${program}:${program ? await fs.stat(program).then((s) => s.mtimeMs, () => 0) : ''}`;
        const old = built.get(kind.id);
        if (old?.key === key) return old.harness;
        const harness = kind.build(program, full);
        built.set(kind.id, { key, harness });
        return harness;
      }),
    );
}
