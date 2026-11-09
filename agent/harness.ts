// What the plugin needs of a coding agent's command line to work for its owner (D-097). Each
// harness has an adapter, such as claude.ts, that owns its turn, its isolation proof and the setup
// it offers; plugin.ts calls only this and never names a harness.
import os from 'node:os';
import path from 'node:path';
import type { SetupChoice } from '../shared/types.ts';

/** One turn: `message` goes on stdin, never in arguments, which `ps` shows. */
export interface Turn {
  cwd: string;
  /** The first turn starts this session; a later one with `resume` continues it. */
  session: string;
  resume: boolean;
  message: string;
  /** The JSON schema the answer must fit. */
  schema: object;
  /** What of the owner's setup to load, as they chose (R-039): their instructions file, and a folder of copies of their chosen skills. */
  setup: { instructions?: string; skills?: string };
  signal: AbortSignal;
  /** Takes what the model does now, in a sentence, each time the adapter can tell (docs/decisions/stop-pauses-run.md). */
  progress?: (sentence: string) => void;
}

export interface Harness {
  /** Its name for the owner, such as "Claude Code", which `SetupChoice.off` names. */
  readonly name: string;
  /**
   * Why this laptop cannot run its turns, or undefined. With `dir`, why its shell could read a
   * secret folder while it works there, or undefined when the adapter proves it cannot. A turn for
   * `answers` runs in a scratch copy and pushes nothing, so an adapter whose only gap is the
   * owner's login may allow it while it refuses `cards`, the default: answers only is the floor.
   */
  refusal(dir?: string, purpose?: 'cards' | 'answers'): Promise<string | undefined>;
  /**
   * What of the owner's setup it can load: the instructions file and the skills folder it reads,
   * and the knobs it honors, named as in `SetupChoice`, such as `noAttribution`. It declares a knob
   * only when it honors it without running code outside the sandbox and without changing
   * permission or sandbox mode (D-115).
   */
  offers(): { instructions?: string; skills?: string; knobs: string[] };
  /** What the laptop has of it: its version, and whether it is signed in, each left out when it cannot tell. */
  found(): Promise<{ version?: string; signedIn?: boolean }>;
  /** Takes the owner's choice for its knobs: before any proof or turn, and again whenever it changes. */
  apply(choice: SetupChoice): Promise<void>;
  /** Runs one turn, and resolves to its answer for the schema. */
  turn(turn: Turn): Promise<unknown>;
}

/**
 * The folders the model must never read: the plugin's, with the agent's keys, and gh's, with the
 * owner's token. On macOS gh keeps that token in the login keychain, whose files a shell reads (K-54).
 */
export function secretDirs(dataDir: string) {
  const ghDir = process.env.GH_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'gh');
  const keychains = process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Keychains')] : [];
  return [dataDir, ghDir, ...keychains].filter(Boolean);
}
