// What WebChat allows a harness to do when the harness asks first (docs/decisions/harness-rulebook.md).
// It only denies or asks, and it knows no protocol: an adapter turns a request into an `Action`.
import { readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const within = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The real path of a file that may not exist yet: its nearest existing folder's, then the rest. A
 * link to a file not made yet counts as its target, where a write through it lands (K-55).
 */
export function real(file: string, hops = 0): string {
  try {
    // Unlike Node's own, the native call resolves as the kernel does: `..` after a link goes up from
    // the link's target, and on macOS a name in other letter case is the same folder.
    return realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    if (parent === file) return file;
    const dir = real(parent, hops);
    const here = path.join(dir, path.basename(file));
    let target: string;
    try {
      target = readlinkSync(here);
    } catch {
      return here;
    }
    // Not path.resolve, which applies `..` before the links. A kernel follows at most 40 links, so
    // this stops there too, which also ends a loop.
    return hops < 40 ? real(path.isAbsolute(target) ? target : `${dir}${path.sep}${target}`, hops + 1) : here;
  }
}

/** What a harness wants to do. The kinds are ACP's tool kinds, which are the common ones. */
export interface Action {
  /** The name of the tool, when it has one. */
  tool?: string;
  kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  /** Absolute paths it touches. */
  paths: string[];
}

export interface Rules {
  /** The only folders a path may be in. */
  folders: string[];
  secrets: string[];
  /** WebChat's own tools, which a harness may always call. */
  tools: string[];
}

/** `ask` marks a no that an owner could turn into a yes: with no owner to ask, it is a no. */
export type Verdict = { allow: true } | { allow: false; why: string; ask?: true };

export function judge({ tool, kind, paths }: Action, { folders, secrets, tools }: Rules): Verdict {
  const deny = (why: string): Verdict => ({ allow: false, why });
  const ask = (why: string): Verdict => ({ allow: false, why, ask: true });
  const files = paths.map((file) => real(file));
  if (files.some((file) => secrets.some((dir) => within(file, real(dir))))) return deny('That folder holds secrets the WebChat plugin keeps from the model.');
  if (files.some((file) => !folders.some((dir) => within(file, real(dir))))) return deny('That path is outside the working folder.');
  // Permission mode is never a knob (D-115).
  if (kind === 'switch_mode') return deny('A harness does not change its own permission mode.');
  // A harness may prefix the name with its server's. An ACP agent writes the name itself, so only the whole name of a tool call counts.
  const own = tool ? /^(?:mcp__[\w-]+__|[\w-]+: )?(\w+)$/.exec(tool)?.[1] : undefined;
  if (own && tools.includes(own) && (kind === 'other' || kind === 'think')) return { allow: true };
  // A read or a search that names no path could be of anything.
  if (kind === 'read' || kind === 'search') return paths.length ? { allow: true } : ask('I cannot tell what it reads.');
  if (kind === 'think' || kind === 'fetch') return { allow: true };
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return paths.length ? { allow: true } : ask('I cannot tell which file it changes.');
  return ask(kind === 'execute' ? 'WebChat cannot check a shell command.' : 'WebChat knows no rule for this.');
}
