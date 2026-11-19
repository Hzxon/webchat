import { type RunRequest } from '../shared/types.ts';
import { type TakenRequest } from './client.ts';
import { type Bench } from './bench.ts';
import type { Harness } from './harness.ts';

/** What the agent says of itself over the socket (docs/decisions/locked-room.md); `text` is what `webchat-agent status` prints. */
export interface AgentStatus {
  text: string;
  paired: boolean;
  asleep: boolean;
  /** The rest is left out while the agent is not serving: not paired, asleep or connecting. */
  server?: string;
  signedIn?: boolean;
  /** The agent's own GitHub login, when it is signed in and GitHub answered. */
  github?: string;
  /** Why every card fails at once, when one does. */
  refusal?: string;
  linked?: string[];
  folders?: string[];
}

export interface PluginOptions {
  /** The pairing code, after WebChat's address, for `dev`; setup pairs the keyholder (docs/decisions/locked-room.md). */
  code: string;
  /** The agent's own folder: the account and the lock, which no harness can read. */
  dataDir: string;
  /** Where the agent clones a repository its owner asks for: `~/WebChat` (D-108). */
  cloneRoot: string;
  /**
   * Every coding agent WebChat supports, as the laptop has it, with no program for one it lacks.
   * The owner links each, and names one in each request; a request that names none runs on the
   * first linked. Left out when `bench` is.
   */
  harnesses?: Harness[];
  /** What works in the owner's folders: a `LocalBench` over `harnesses` when left out, or the keyholder's `SocketBench` (docs/decisions/locked-room.md). */
  bench?: Bench;
  /** Set with a `SocketBench`: resolves with a signal that aborts when the runner goes, once one is connected. */
  runner?: { up(): Promise<AbortSignal> };
  /** Finds the harnesses again, which `harnesses` holds as found when the host started: every minute, so one installed later shows (docs/decisions/harness-linking.md). */
  find?: () => Promise<Harness[]>;
}

/** A linked board's copy in its repository, as the agent keeps it on disk (R-040). */
export interface BoardCopy {
  repo: string;
  /** The board's versions as last seen, and when they last moved; 0 once their copy went to the repository. */
  seen: string;
  moved: number;
  /** Each proposal file sent as a draft, by path: the blob sent, the draft's client id, and whether the owner added it. */
  proposals: Record<string, { blob: string; draft: string; added?: boolean }>;
  /** The cards open pull requests claim, as last sent. */
  claims?: string;
}

/** Where a run's work happens. */
export interface Place {
  branch: string;
  worktree: string;
  /** Origin's default branch, such as `origin/main`, which the briefs and the draft name. */
  base: string;
  /** The commit of it the run began from, which what the run pushes is checked to build on. */
  tip: string;
  pull?: { repo: string; number: number };
}

/** A draft pull request this server opened, watched until it is someone else's. Kept on disk. */
export interface Watched extends Place {
  taken: TakenRequest;
  request: RunRequest;
  pull: { repo: string; number: number };
  head: string;
  fixes: number;
  /** What a round took up already: the head whose CI failure or conflict, and the newest review note's time. */
  seenHead: string;
  seenNote: string;
  /** When GitHub last saw the pull request change, so an unchanged one needs no look at its line comments. */
  seenUpdate?: string;
  /** The background Claude session that made it, which each round of fixes resumes. None before R-035. */
  session?: string;
  /** The harness that made it, which each round resumes; none before the pick, so the host's. */
  harness?: string;
  /**
   * Reviews by others than the owner, each waiting for the owner's go by the id of the report that
   * showed it, with exactly the text that report showed (D-105).
   */
  waiting?: Array<{ report: number; line: string; details: string }>;
  /** The owner's go, with the review it approves and their own words, which the next look takes up. */
  go?: { review?: number; note: string };
  /**
   * Set until the run's work is done: since when it waits for a decision nobody foresaw, and whether
   * its owner was reminded (R-042). `stopped` says the owner paused it instead, and it waits for
   * their words (docs/decisions/stop-pauses-run.md).
   */
  unfinished?: { paused?: number; reminded?: boolean; stopped?: true; overlap?: Overlap };
  /** The earlier draft its card owners stacked it on, which its body names as `Stacked on #12` (docs/roadmap/new-overlap-gate.md). */
  stacked?: number;
  /** The Proposed decisions the work made true, which its merge accepts (R-042). */
  decisions?: string[];
}

/** Why a run waits: an earlier draft holds files it needs, until that draft lets them go or the two card owners choose (docs/roadmap/new-overlap-gate.md). */
export interface Overlap {
  /** The earlier draft, its card such as K-12, or `#12` when it claims none, and its branch. */
  number: number;
  waits: string;
  branch: string;
  /** The newest revision of the waiting card when the wait began: only a choice written after it counts. */
  since: number;
  /** For work that grew into a held file: the files its branch changes, which were not pushed. */
  files?: string[];
  /** For work that has not started: the brief it starts with. */
  start?: string;
}

/**
 * A run whose card holds, waiting for its owner's go on its plan before the claim commit, so it has
 * no draft yet (docs/decisions/redirect-plan-gate.md). Kept on disk.
 */
export interface Planned extends Place {
  taken: TakenRequest;
  request: RunRequest;
  session: string;
  /** The harness that ran the check, by name, which the work resumes with. */
  harness: string;
  repo: string;
  /** The draft's body, with what the check read. */
  body: string;
  /** When the plan was reported. */
  at: number;
}

/** How a background Claude's turn on a card ends (D-097): done, failed, or paused for a decision (R-042). */
export interface Answer {
  outcome: 'done' | 'failed' | 'decision';
  note: string;
  title?: string;
  body?: string;
  drafts?: unknown;
  decisions?: unknown;
}

export type Pull = { number: number; title: string; body?: string; headRefName?: string; files?: { path: string }[] };

export interface PullView {
  state: string;
  isDraft: boolean;
  headRefOid: string;
  mergeable: string;
  statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; detailsUrl?: string }>;
  reviews: Array<{ author: { login: string }; body: string; submittedAt: string }>;
  comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
  updatedAt: string;
}

/** What a command filed for the serving agent to ask its owner: `at` is when the command ran. */
export type Filed = ({ kind: 'link'; harness: string } | { kind: 'connect'; repo: string; dir: string }) & { at?: number };

/** A request sent and not answered: what it asked (a harness name, or a repository), for a connect the folder, and when the agent sent it. */
export interface Asked {
  kind: 'link' | 'connect';
  what: string;
  dir?: string;
  at: number;
}

/** Who a turn is for: a card's run, or a conversation. `asks` says the owner's page can show a question. */
export type Who = { taken: TakenRequest; asks?: true } | { chat: number; to: string; asks?: true; own?: boolean; events?: true };
