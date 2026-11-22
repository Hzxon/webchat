import { type PublicKeysDTO, type UserDTO } from './account.js';

/**
 * What a plugin session can do, by the level its check-ins name (D-103): 1 answers the owner's
 * questions; 2 also runs cards from the pane, which it names only while `gh` is signed in (D-105).
 * Since R-039 the level is a set of these bits, with 4 for a plugin that heeds its owner's `setup`:
 * 5, or 7 with cards (D-115). 8 says it asks its owner before an action its harness would ask about
 * (docs/decisions/harness-approvals.md). 16 says it runs a session its owner starts in their own
 * harness setup, once they turned that on (D-157), 32 that it sends a session's steps, and 64 that
 * it takes a model, a permission mode and a hand over from the session's controls, and 128 that it
 * lists a terminal's sessions in a connected folder and goes on with one (R-072). 512 says a hand
 * over can switch a session between the owner's own setup and restricted
 * (docs/decisions/new-setup-switch.md). Every
 * level from 1 up answers, older ones included. The server takes any level under `MAX_AGENT_LEVEL`;
 * it took one under 100 before 64, and an agent follows its server's release, so none meets an
 * older server.
 */
export const AGENT_LEVEL = { answers: 1, cards: 2, setup: 4, asks: 8, own: 16, events: 32, controls: 64, sessions: 128, anywhere: 256, switches: 512 } as const;

/** The levels the server takes: one bit for each of 16 behaviours. */
export const MAX_AGENT_LEVEL = 2 ** 16;

/** Whether a session at this level runs cards, heeds `setup`, or asks (D-105, D-115). */
export const runsCards = (level: number) => (level & AGENT_LEVEL.cards) !== 0;
export const takesSetup = (level: number) => (level & AGENT_LEVEL.setup) !== 0;
export const takesAsks = (level: number) => (level & AGENT_LEVEL.asks) !== 0;
export const takesOwn = (level: number) => (level & AGENT_LEVEL.own) !== 0;
export const takesControls = (level: number) => (level & AGENT_LEVEL.controls) !== 0;
export const listsSessions = (level: number) => (level & AGENT_LEVEL.sessions) !== 0;
export const switchesSetup = (level: number) => (level & AGENT_LEVEL.switches) !== 0;
/** Whether it answers a prompt that names neither a project nor a repository, in an empty folder. */
export const asksAnywhere = (level: number) => (level & AGENT_LEVEL.anywhere) !== 0;

/** A harness's session that a terminal started in a connected folder, as the pane lists it (R-072). */
export interface TerminalSessionDTO {
  id: string;
  /** Its first prompt's first line, the harness's own text, shown as plain text. */
  title: string;
  at: number;
}

/** How long a question of an agent waits for its owner: the plan gate's 7 days. */
export const ASK_WAIT_MS = 7 * 24 * 60 * 60_000;

/** What a choice loads, in words, for the agent's answer and the pane alike (R-039). */
export const setupWords = (c: SetupChoice) => [c.claudeMd && 'your CLAUDE.md', ...c.skills, c.noAttribution && 'no AI attribution', c.noPlan && 'no plan first', c.own?.length && `your own setup in your ${c.own.join(' and ')} sessions`].filter(Boolean).join(', ') || 'nothing of your Claude setup';

/**
 * What the owner's agent loads from their setup on its laptop into every run and turn (R-039,
 * D-115): the instructions file its harness reads, skills of its skills folder by folder name, and
 * no AI attribution lines in commits and pull requests. One choice serves every harness, each
 * through the knobs it declares.
 */
export interface SetupChoice {
  /** The instructions file, under its first name, which old pages and plugins still use. */
  claudeMd: boolean;
  skills: string[];
  noAttribution: boolean;
  /**
   * The harnesses the owner linked, by name, in the order that picks one for a request that names
   * none (docs/decisions/harness-linking.md). An agent from before it has none until it first
   * starts; a page from before it sends none, and the agent keeps what it had.
   */
  linked?: string[];
  /** The harnesses an older page turned off, by name: still read, and they mute a linked one. A page that sends `linked` sends none. */
  off?: string[];
  /** Whether a card run goes on without showing its plan first; a page from before the gate sends none, which keeps it on (docs/decisions/redirect-plan-gate.md). */
  noPlan?: boolean;
  /**
   * The harnesses whose sessions the owner starts run in their own setup, by name: their folder,
   * settings, hooks, plugins, MCP servers and permission rules, with no sandbox of WebChat's. Off at
   * first; a card run never does (D-157).
   */
  own?: string[];
}

/** A harness the owner's agent found on its laptop, as Settings shows it (D-115). */
export interface HarnessState {
  /** Its name for the owner, such as "Claude Code", which `SetupChoice.off` names. */
  name: string;
  version?: string;
  /** Whether it is signed in, when its adapter can tell. */
  signedIn?: boolean;
  /** Where the agent found it, with `~` for the home folder; none when it found none. */
  path?: string;
  /** Whether the owner linked it and it is not turned off. Undefined from a plugin that has no linking. */
  linked?: boolean;
  /** What a linked harness needs the owner to see: it cannot run turns, is too old or signed out, or its sandbox lets its shell read more than WebChat allows. */
  attention?: string;
  /** Why it answers no questions: not linked, turned off, missing or too old. Undefined from an agent before linking, whose `refusal` stands for both. */
  answers?: string;
  /** Why it runs nothing on this laptop, which is what `answers` says too, or nothing when it does. */
  refusal?: string;
  /** The instructions file and the skills folder it reads, such as `~/.claude/CLAUDE.md`. */
  instructions?: string;
  skills?: string;
  /** The knobs its adapter honors, named as in `SetupChoice`, such as `noAttribution`. */
  knobs: string[];
  /** The models a session can pick for it, by the names its command line takes (R-072). */
  models?: string[];
  /** The effort levels a session can pick, by model, with `''` for the harness's default model, by the names the harness takes. */
  efforts?: Record<string, string[]>;
}

export type HarnessRow = 'linked' | 'attention' | 'found' | 'missing';

/** What each row says, for Settings and `doctor` alike. */
/**
 * What the owner reads before and after linking a harness that WebChat cannot fully confine, by its
 * name (docs/decisions/new-hermes-unconfined.md, docs/decisions/new-antigravity-harness.md).
 */
export const HARNESS_WARNING: Record<string, string> = {
  Hermes:
    'Hermes runs with no sandbox and loads your own Hermes setup: your config, memory, plugins, hooks and MCP servers. A teammate’s question or card can make it read or change your files and use your tools, such as your email. The agent’s keys stay out of its reach.',
  Antigravity:
    'Antigravity runs its shell in its own sandbox, apart from your Antigravity setup, but its file, web and MCP tools are outside that sandbox. A repository’s .agents/mcp_config.json would run a command as you, so WebChat refuses a turn in a folder that has one. A file the model writes during a turn can still load before the turn ends.',
};

export const HARNESS_ROW_WORDS: Record<HarnessRow, string> = { linked: 'Linked', attention: 'Linked, needs attention', found: 'Found, not linked', missing: 'Not found' };

/** Which of the four rows Settings shows for a harness, and `doctor` too. */
export const harnessRow = (h: HarnessState): HarnessRow => (h.linked ? (h.attention ? 'attention' : 'linked') : h.path ? 'found' : 'missing');

/** A harness the owner picked at pairing, as its pairing code seals it for the approval dialog. */
export interface PairingPick {
  name: string;
  version?: string;
  signedIn?: boolean;
}

/** The agent's answer to its owner's `setup`: what the laptop offers, the choice it keeps, and what its last run or turn loaded (R-039). */
export interface SetupState {
  /** The client id of the `setup` it answers, which the owner's page waits for. */
  to: string;
  claudeMd: boolean;
  /** Each skill in `~/.claude/skills`, by folder name, with the description its SKILL.md gives. */
  skills: Array<{ name: string; description: string }>;
  choice: SetupChoice;
  applied?: SetupChoice & { at: number };
  /** Each harness the laptop has. A plugin from before D-115's rewrite sends none: it runs Claude Code alone. */
  harnesses?: HarnessState[];
}

/** A skill's folder name, which cannot lead out of `~/.claude/skills` (R-039). */
export const SKILL_NAME = /^[\w-][\w.-]{0,63}$/;

/** Where each release's agent files are: the install line and the agent's updater both read them here, never from the server (docs/decisions/agent-self-update.md). */
export const AGENT_RELEASES = 'https://github.com/Hzxon/webchat/releases/download';

/**
 * A coding agent's half of a pairing (R-030, D-093): the keys and login key of the account its
 * owner is about to approve. The id and the proof come from the code the owner's page showed, so
 * the server can match the two halves without learning the code.
 */
export interface PairingInput {
  id: string;
  keys: PublicKeysDTO;
  /** HMAC of the agent's keys under the code. The owner's page checks it before approving. */
  proof: string;
  /** The agent's login key, random, since an agent has no password. */
  authKey: string;
  /** The harnesses it asks to link, sealed under the code (`sealPicks`); the server cannot read them. */
  picks?: string;
}

export interface PairingDTO {
  keys: PublicKeysDTO;
  proof: string;
  /** Once the owner approved: the agent's new account, and the owner's keys bound to the code. */
  approved: { user: UserDTO; owner: { id: number; keys: PublicKeysDTO }; proof: string } | null;
  picks?: string;
}

/** How long a pairing code works, from the page showing it to the owner's approval (R-030). */
export const PAIRING_TTL_MS = 10 * 60_000;

export interface ApprovePairingInput {
  displayName: string;
  /** HMAC of the owner's id and keys and the agent's keys under the code. The agent checks it. */
  proof: string;
}
