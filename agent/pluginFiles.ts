import { readFileSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repoHome } from './keep.ts';

/** The mark that names a repository's folder on this laptop, which only the owner's connect or clone writes (D-101, D-108). */
export const markOf = (dataDir: string, repo: string) => path.join(repoHome(dataDir, repo), 'connected');

/** What the agent says when the laptop has no folder of a repository (R-036). */
export const noCopy = (repo: string) => `I have no copy of ${repo} on this laptop.`;

/** A folder as the owner reads it, with their home as ~. */
export const shown = (dir: string) => (dir.startsWith(os.homedir() + path.sep) ? `~${dir.slice(os.homedir().length)}` : dir);

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The lock files this process holds, freed at exit. A set, since an agent that sleeps and wakes takes its lock again. */
export const held = new Set<string>();
process.on('exit', () => held.forEach(freeLock));

/** Frees a lock file if this process holds it. */
export function freeLock(file: string) {
  held.delete(file);
  try {
    if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
  } catch {
    // Someone removed it already.
  }
}

/** Takes a lock file for this process unless a live process holds it, and frees it at exit. */
export async function takeLock(file: string) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx' });
      held.add(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
      if (pid > 0 && alive(pid)) return false;
      await fs.rm(file, { force: true });
    }
  }
  return false;
}
