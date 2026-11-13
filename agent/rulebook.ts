// What WebChat allows a harness to do when the harness asks first (docs/decisions/harness-rulebook.md).
// It only denies or asks, and it knows no protocol: an adapter turns a request into an `Action`.
import { readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
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

/**
 * The places a shell command names: its words after the program that start like one, absolute, in
 * the home folder or going up, which is all that can be read of a command. They are resolved from
 * `cwd`. The program itself, such as `/bin/zsh -lc`, is no place it reads.
 */
export const shellPaths = (command: string, cwd: string) =>
  command
    .split(/\s+/)
    .slice(1)
    .map((word) => word.replace(/^['"]|['"]$/g, ''))
    .filter((word) => /^(\/|~|\.\.)/.test(word) || word.includes('../'))
    .map((word) => path.resolve(cwd, word.startsWith('~') ? os.homedir() + word.slice(1) : word));

/** What a harness wants to do. The kinds are ACP's tool kinds, which are the common ones. */
export interface Action {
  /** The name of the tool, when it has one. */
  tool?: string;
  kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  /** Absolute paths it touches. */
  paths: string[];
  /** The addresses it opens, as given. */
  urls?: string[];
}

export interface Rules {
  /** The only folders a path may be in. */
  folders: string[];
  secrets: string[];
  /** WebChat's own tools, which a harness may always call. */
  tools: string[];
  /** The ports of the run's dev server, for a run that has a browser (R-046). */
  ports?: number[];
}

/** `ask` marks a no that an owner could turn into a yes: with no owner to ask, it is a no. */
export type Verdict = { allow: true } | { allow: false; why: string; ask?: true };

/**
 * The tools of the browser, `chrome-devtools-mcp`, that a run may call (R-046): pages, input, size
 * and emulation, the snapshot and screenshot, the console and network lists, and scripts in the
 * page. Named one by one, so a new version adds none unseen.
 */
export const BROWSER_TOOLS = ['click', 'click_at', 'drag', 'fill', 'fill_form', 'handle_dialog', 'hover', 'press_key', 'type_text', 'upload_file', 'close_page', 'list_pages', 'navigate_page', 'new_page', 'select_page', 'wait_for', 'emulate', 'resize_page', 'list_network_requests', 'get_network_request', 'list_console_messages', 'get_console_message', 'evaluate_script', 'take_snapshot', 'take_screenshot', 'get_css_styles'];

/**
 * Whether an address is the run's dev server: a `localhost` name or a loopback address, on a run
 * port (R-046). The browser's proxy is the boundary, since a page can redirect or fetch anywhere;
 * `judge` uses this only to refuse early an argument named `url` that the proxy would refuse.
 */
export function onRunPort(address: string, ports: number[]) {
  if (address === 'about:blank') return true;
  const url = URL.parse(address);
  if (!url) return false;
  const { protocol, hostname, port } = url;
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
  return /^(https?|wss?):$/.test(protocol) && loopback && ports.includes(Number(port));
}

export function judge({ tool, kind, paths, urls = [] }: Action, { folders, secrets, tools, ports }: Rules): Verdict {
  const deny = (why: string): Verdict => ({ allow: false, why });
  const ask = (why: string): Verdict => ({ allow: false, why, ask: true });
  const files = paths.map((file) => real(file));
  if (files.some((file) => secrets.some((dir) => within(file, real(dir))))) return deny('That folder holds secrets the WebChat plugin keeps from the model.');
  if (files.some((file) => !folders.some((dir) => within(file, real(dir))))) return deny('That path is outside the working folder.');
  // Permission mode is never a knob (D-115).
  if (kind === 'switch_mode') return deny('A harness does not change its own permission mode.');
  // Its paths passed above; a run with no dev server has no browser.
  const browser = /^mcp__browser__(.*)$/.exec(tool ?? '')?.[1];
  if (browser !== undefined) {
    if (!ports || !BROWSER_TOOLS.includes(browser)) return deny('WebChat does not let a run use that browser tool.');
    return urls.every((url) => onRunPort(url, ports)) ? { allow: true } : deny('The browser opens only this run’s dev server.');
  }
  // A harness may prefix the name with its server's. An ACP agent writes the name itself, so only the whole name of a tool call counts.
  const own = tool ? /^(?:mcp__[\w-]+__|[\w-]+: )?(\w+)$/.exec(tool)?.[1] : undefined;
  if (own && tools.includes(own) && (kind === 'other' || kind === 'think')) return { allow: true };
  // A read or a search that names no path could be of anything.
  if (kind === 'read' || kind === 'search') return paths.length ? { allow: true } : ask('I cannot tell what it reads.');
  if (kind === 'think' || kind === 'fetch') return { allow: true };
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return paths.length ? { allow: true } : ask('I cannot tell which file it changes.');
  return ask(kind === 'execute' ? 'WebChat cannot check a shell command.' : 'WebChat knows no rule for this.');
}
