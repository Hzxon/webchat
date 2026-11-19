// What the agent needs of a coding agent's command line to work for its owner (D-097). Each
// harness has an adapter, such as claude.ts, that owns its turn, its warning and the setup
// it offers; plugin.ts calls only this and never names a harness.
import os from 'node:os';
import path from 'node:path';
import type { PermissionMode, SessionAboutDTO, SessionEventDTO, SetupChoice, TerminalSessionDTO } from '../shared/types.ts';
import type { Lab } from './browser.ts';
import type { Quiet } from './runner.ts';
import type { Action } from './rulebook.ts';

/** What a harness asks before an action: the rulebook's `Action`, and what the owner reads of it. */
export interface Ask extends Action {
  /** The command, the paths or the URL, exactly as the harness gave it, never the model's own description. */
  detail: string;
}

/** The answer to an `Ask`. A refusal's message is a fixed sentence, which the model reads. */
export type Reply = { allow: true } | { allow: false; message: string };

/** One turn: `message` goes on stdin, never in arguments, which `ps` shows. */
export interface Turn {
  cwd: string;
  /** The first turn starts this session; a later one with `resume` continues it. */
  session: string;
  resume: boolean;
  message: string;
  /** The JSON schema the answer must fit. */
  schema: object;
  /** Every schema the turns of this session may use, for a harness that fixes one for its process. */
  schemas?: object[];
  /** What of the owner's setup to load, as they chose (R-039): their instructions file, and a folder of copies of their chosen skills. */
  setup: { instructions?: string; skills?: string };
  /**
   * Runs in the owner's own setup, as their terminal would, with none of WebChat's sandbox or
   * rules: only a session its owner started in their words, while their setup turns it on, and
   * never a card run (D-157). Only an adapter whose `offers` has the `own` knob gets it.
   */
  own?: boolean;
  /** The model the session's controls picked, by a name `offers().models` lists (R-072). */
  model?: string;
  /** The permission mode the session's controls picked, set only with `own`: a restricted run keeps its own (D-115). */
  mode?: PermissionMode;
  signal: AbortSignal;
  /** Takes what the model does now, in a sentence, each time the adapter can tell (docs/decisions/stop-pauses-run.md). */
  progress?: (sentence: string) => void;
  /** Takes each step of the session as the harness reports it, for the owner's timeline (R-072). */
  events?: (event: SessionEventDTO) => void;
  /** Takes what the session runs with, a part at a time, as the harness says it (R-072). */
  about?: (about: SessionAboutDTO) => void;
  /**
   * Asks the owner before an action the harness would ask about, and rejects when the run cannot go
   * on. Set only when the owner's page can show the question; without it an adapter refuses such an
   * action, as it always did (docs/decisions/harness-approvals.md).
   */
  ask?: (ask: Ask) => Promise<Reply>;
  /** Holds the turn's silence timer while `ask` waits for the owner. */
  quiet?: Quiet;
  /** The run's dev server and the proxy its browser goes through, for a harness that browses (R-046). */
  lab?: Lab;
  /** Sends a PNG in the working folder to the owner, as a photo in the run's thread, and says what became of it (R-046). */
  shot?: (file: string, caption: string) => Promise<string>;
}

export interface Harness {
  /** Its name for the owner, such as "Claude Code", which `SetupChoice.off` names. */
  readonly name: string;
  /** Whether it calls `Turn.ask`, which the level an agent names says (AGENT_LEVEL.asks). */
  readonly asks: boolean;
  /** False for one whose sandbox keeps `.git` read-only, so it cannot commit; its leftovers are committed for it. Left out means it commits. */
  readonly commits?: boolean;
  /** Why this laptop cannot run its turns, or undefined. The locked room keeps the secrets from every harness, so this is not an isolation check (docs/decisions/locked-room.md). */
  refusal(): Promise<string | undefined>;
  /** What the owner should know about its sandbox while it runs: a managed setting that lets its shell read the owner's secrets. It stops nothing. */
  warning?(): Promise<string | undefined>;
  /**
   * The folders its sandbox keeps from its shell, for a harness that can drive the browser of
   * R-046: the dev server it starts is kept from them too. Left out means it has no browser.
   */
  readonly secrets?: string[];
  /** Whether its shell cannot leave its sandbox now, so a command it asks about needs no owner (docs/decisions/harness-rulebook.md). Left out means it can. */
  sandboxed?(): Promise<boolean>;
  /**
   * What of the owner's setup it can load: the instructions file and the skills folder it reads,
   * and the knobs it honors, named as in `SetupChoice`, such as `noAttribution`. It declares a knob
   * only when it honors it without running code outside the sandbox and without changing
   * permission or sandbox mode (D-115), except `own`, which says it can run `Turn.own` (D-157).
   */
  offers(): { instructions?: string; skills?: string; knobs: string[]; models?: string[] };
  /** What the laptop has of it: where it is, its version, and whether it is signed in, each left out when it cannot tell. */
  found(): Promise<{ path?: string; version?: string; signedIn?: boolean }>;
  /** Takes the owner's choice for its knobs: before any proof or turn, and again whenever it changes. */
  apply(choice: SetupChoice): Promise<void>;
  /** Runs one turn, and resolves to its answer for the schema. */
  turn(turn: Turn): Promise<unknown>;
  /** The newest sessions the owner's terminal started in `cwd`, for a harness that can resume one there (R-072). */
  sessions?(cwd: string): Promise<TerminalSessionDTO[]>;
  /** Ends what an adapter keeps running for a session, once the session is over, or for every session when the agent shuts down. An adapter that starts a process for each turn has nothing to end. */
  end?(session?: string): Promise<void>;
}

/** Whether a variable holds a credential: by its name, by a known token's prefix, or by a password in a URL. */
export const isCredential = ([name, value = '']: [string, string | undefined]) =>
  /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH/i.test(name) ||
  /^(gh[opsur]_|github_pat_|npm_|sk-|xox[abprs]-|glpat-|AKIA)|:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);

/**
 * The folders the model must never read: the plugin's, with the agent's keys, and gh's, with the
 * owner's token. On macOS gh keeps that token in the login keychain, whose files a shell reads (K-54).
 */
export function secretDirs(dataDir: string) {
  const ghDir = process.env.GH_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'gh');
  const keychains = process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Keychains')] : [];
  return [dataDir, ghDir, ...keychains].filter(Boolean);
}

/** Whether `found` is at least `min`, comparing dotted numbers up to the first other character. A version that is no number counts as new enough. */
export function versionAtLeast(found: string | undefined, min: string) {
  const parts = (version: string) => (/^\d+(\.\d+)*/.exec(version)?.[0] ?? '').split('.').map(Number);
  if (!found || !/^\d/.test(found)) return true;
  const [have, need] = [parts(found), parts(min)];
  for (let i = 0; i < Math.max(have.length, need.length); i++) if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  return true;
}

/** Why an adapter refuses a harness older than the release it needs, or undefined. */
export const olderThan = (name: string, found: string | undefined, min: string) =>
  versionAtLeast(found, min) ? undefined : `${name} ${found} is older than ${min}, which I need. Update it.`;
