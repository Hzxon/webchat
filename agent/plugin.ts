// The keyholder's half of the agent (R-030, D-092, docs/decisions/locked-room.md): it holds the agent's
// keys and its own `gh` login, and serves every folder the owner connected or had it clone, while
// a runner as the owner works in those folders. It checks in once for all those folders, and takes their run requests,
// checked as the daemon checks them (D-089); a request for a repository with no folder waits for
// the owner to have it cloned (D-108). For each run it adds a worktree inside the folder and runs a
// background Claude there, restricted and sandboxed, with the card on stdin (D-097). The turn ends
// with a JSON answer, and this server pushes the branch and opens the draft pull request. It then
// watches the draft, and when CI fails on it, it conflicts, or someone who may push reviews it, the
// same Claude session takes another turn.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pairingId, textHash } from '../shared/e2ee.ts';
import { cardsOf, copyOf, entriesOf, proposalOf, readCard, usernamesOf, type DocSection } from '../shared/board.ts';
import { AGENT_LEVEL, isHeld, isRepoName, LIMITS, setupWords, type BoardSyncDTO, type CardDraftDTO, type DocDTO, type HarnessState, type AskDTO, type PairingPick, type ProjectDTO, type ProjectReposDTO, type RunFix, type RunRequest, type SessionAboutDTO, type SessionEventDTO, type SetupChoice } from '../shared/types.ts';
import { ApiError } from './api.ts';
import { AgentClient, checkInEvery, readPairing, SYNC_INTERVAL_MS, type OpenedMessage, type TakenRequest } from './client.ts';
import { Conversations, type Answerer, type Conversation } from './conversations.ts';
import { LocalBench, NO_RUNNER, PrerequisitesMissing, type Bench, type Folder, type HarnessInfo } from './bench.ts';
import { Keep } from './keep.ts';
import { Permits, SEND_GAP_MS } from './permits.ts';
import { messageOf, REQUEST_TTL_MS, Runs, type Runner, type RunResult } from './runs.ts';
import { type AgentStatus, type Answer, type Asked, type BoardCopy, type Filed, type Overlap, type Place, type Planned, type PluginOptions, type Pull, type PullView, type Watched, type Who } from './pluginTypes.ts';
import { cardKey, choiceOf, choosers, overlaps, stackedLine, type Pull as Footprint } from '../shared/overlap.ts';
import { ANSWER, CHECK, REPLY } from './pluginSchemas.ts';
import { OWNER, cardAsk, checkBrief, fence, fixBrief, goBrief, inParts, overlapBrief, planBrief, promptBrief, pullList, seenOf, steerBrief, workBrief } from './briefs.ts';
import { draftsOf, line } from './drafts.ts';
import { freeLock, markOf, noCopy, shown, takeLock } from './pluginFiles.ts';
export { line } from './drafts.ts';
export type { AgentStatus, PluginOptions } from './pluginTypes.ts';

const exec = promisify(execFile);
const gh = (args: string[]) => exec('gh', args, { maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout.trim());
const signedIn = () => gh(['auth', 'status', '--hostname', 'github.com']).then(() => true, () => false);
/** How the owner wakes the agent, for "To wake me, …". */
const WAKE = 'run webchat-agent wake in a terminal on your laptop';
/** How long a run or a turn waits for its owner to have its repository cloned (R-036). */
const CLONE_WAIT_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** The least time between two progress reports on a run (docs/decisions/stop-pauses-run.md). */
const PROGRESS_MS = 30_000;
/** A conversation's steps go to its owner at most this often, in one sealed message each time (R-072). */
export const EVENTS_MS = 5_000;

/** Rounds of fixes one pull request gets. */
const MAX_FIXES = 3;
/** Check results that mean the code broke, not that someone stopped or held the check. */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);
const PULL_FIELDS = 'state,isDraft,headRefOid,mergeable,statusCheckRollup,reviews,comments,updatedAt';

/** The branch a board's copy goes to, in one draft pull request (R-040, D-117). */
const BOARD_BRANCH = 'agent/board';

/** A run's branch name from its card, as `agent/<slug>`. */
const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/** The card a pull request names, as its key: its body opens with "Claims K-12", as `scripts/claim.sh` and the agent write it, or its title names the card. */
function cardOfPull(pull: Pull) {
  const named = /^Claims ([RKQ]-\d+)\b/.exec(pull.body ?? '') ?? /\b([RKQ]-\d+)\b/.exec(pull.title);
  return named ? cardKey(named[1]!) : undefined;
}

/** The card an open pull request claims. The agent's own drafts show In review already, so they claim nothing here (R-040, R-042). */
const claimOf = (pull: Pull) => (pull.headRefName?.startsWith('agent/') ? undefined : cardOfPull(pull));

/** A repository's open pull requests, with the fields asked for, as `gh` lists them, or undefined when it cannot (R-041). */
const openPulls = (repo: string, fields = 'number,title') =>
  gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', fields]).then(
    (out) => JSON.parse(out) as Pull[],
    () => undefined,
  );

/** What `connect` says in a folder that is no GitHub repository. */
export const NO_REPOSITORY = 'This folder is no GitHub repository, so there is nothing to connect here. Your agent works in every folder it knows, and offers to clone the others when you ask it in WebChat.';

/** Why every request fails until the owner links a harness. */
const NONE_LINKED = 'You have linked no coding agent on this laptop, so I start nothing. Link one in my settings under Coding agents.';

/** How long `webchat-agent card` waits for its owner to add the draft; it stays in the pane after. */
const CARD_WAIT_MS = 30 * 60_000;

// Never the content of a message: this lands in Claude Code's log files.
const log = (error: unknown) => console.error(`webchat: ${messageOf(error)}`);

export class Plugin {
  client: AgentClient | null = null;
  /** Why this process serves nothing, for the status tool. Empty while it serves. */
  problem = 'Starting.';
  private runs: Runs | null = null;
  private conversations: Conversations | null = null;
  private permits: Permits | null = null;
  /** The laptop's folder in the plugin's: its copy of the account, its Claude's settings, its pull requests and conversations. */
  private readonly home: string;
  /** Every folder the laptop has, by repository in lower case, as GitHub ignores case (R-036). */
  private folders = new Map<string, Folder>();
  /** The runs and turns that wait for a repository's clone, by repository in lower case, and the clones going. */
  private readonly waiting = new Map<string, Set<{ resolve: () => void; reject: (error: Error) => void }>>();
  private readonly cloning = new Set<string>();
  private watched: Watched[] = [];
  private plans: Planned[] = [];
  private polling = false;
  /** When a request came or a run or turn last went, which sets how often it checks in. */
  private lastWork = Date.now();
  /** The agent's GitHub login, whose own reviews start a round on their own; the owner's wait for their go when it is another account (D-105, docs/decisions/locked-room.md). */
  private login?: string;
  /** Whether a GitHub login may push to a repository, by "repo login". */
  private readonly writers = new Map<string, boolean>();
  /** Ends the check-ins when the agent goes to sleep. */
  private stop?: AbortController;
  /** Aborts when the runner goes, which ends the check-ins. */
  private lost?: AbortSignal;
  /** Cuts short the minute a waiting process sleeps, so a wake here serves at once. */
  private nudge?: AbortController;
  /** What runs and turns load from the owner's Claude setup, as they chose, and what the last one loaded (R-039). Kept on disk. */
  private setup: { choice: SetupChoice; applied?: SetupChoice & { at: number }; asks?: Record<string, Asked> } = { choice: { claudeMd: false, skills: [], noAttribution: false } };
  /** The harnesses as the laptop last had them, found again every minute. */
  private harnesses: HarnessInfo[] = [];
  private readonly bench: Bench;
  /** Its own clone of each repository, which holds the keys: nothing else here fetches or pushes. */
  private readonly keep: Keep;
  /** The commit of each folder's default branch that was last sent into it, so only what is new goes next. */
  private readonly sent = new Map<string, string>();
  /** Each linked board's copy, by project. Kept on disk. */
  private copies: Record<number, BoardCopy> = {};
  private copying = false;
  /** Each linked board's cards at the versions last read, when origin and GitHub were last looked at, and the proposal files that came to nothing. */
  private readonly cards = new Map<number, { versions: string; roadmap: Array<{ doc: string; section: string; text: string; stands: string }>; decisions: Array<{ doc: string; section: string; text: string }> }>();
  private readonly looked = new Map<number, number>();
  private readonly skipped = new Set<string>();
  /** Each `webchat-agent card` that waits for its owner to add its draft, by the draft's client id (R-044). */
  private readonly adding = new Map<string, (card: string) => void>();

  constructor(private readonly options: PluginOptions) {
    this.home = path.join(options.dataDir, 'laptop');
    this.bench = options.bench ?? new LocalBench(options.harnesses!, options.find, options.dataDir);
    this.keep = new Keep({ dataDir: options.dataDir });
  }

  private file(name: string) {
    return path.join(this.home, name);
  }

  /** Why a process serves nothing while the owner has the agent asleep (K-66, D-113). */
  private get asleepWords() {
    return `Your agent is asleep: it takes no cards and answers no questions. To wake it, ${WAKE}.`;
  }

  /** The one switch for every process and the pane: while it exists, nothing serves (K-66, D-113). */
  private get asleep() {
    return path.join(this.options.dataDir, 'asleep');
  }

  /** Serves while it holds the watch, waits while it cannot, and waits again after the agent goes to sleep. */
  async serve() {
    try {
      while (await this.start()) await this.loop();
    } catch (error) {
      // A removed account is refused on every try. A service that exits on it restarts every 10
      // seconds, and its failed sign-ins use up the address's limit, which the next pairing needs.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      this.problem = 'WebChat refused this agent’s sign-in: it was removed, or paired again. Run `webchat-agent setup` with a new code.';
    }
  }

  /**
   * Takes the laptop's watch, pairs when a new code was pasted, and loads the laptop's copy of the
   * account and the folders it has. False when this process serves nothing; `problem` says why.
   */
  async start(): Promise<boolean> {
    const { dataDir } = this.options;
    if (this.options.runner) {
      // Offline, with no check-ins, until a runner says hello; the loop ends when it goes (D-113).
      this.problem = NO_RUNNER;
      this.lost = await this.options.runner.up();
    }
    this.problem = 'Connecting to WebChat.';
    const { server, code } = this.options.code ? readPairing(this.options.code, '') : { server: '', code: '' };
    const pairedFile = path.join(dataDir, 'account.json');
    let paired = await AgentClient.load(pairedFile).catch(() => null);
    if (!paired && !code) {
      this.problem = 'Not paired. In WebChat, choose Connect coding agent, then run `webchat-agent setup` with its code.';
      return false;
    }
    // Two processes would both claim the laptop's runs (D-085). The second takes over when the first closes.
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    // An agent put to sleep stays asleep in every process, new ones included, until a wake.
    for (;;) {
      const asleep = existsSync(this.asleep);
      if (!asleep && (await takeLock(path.join(dataDir, 'watch.lock')))) break;
      this.problem = asleep ? this.asleepWords : 'Another process on this laptop serves your agent. This one takes over when that one closes.';
      this.nudge = new AbortController();
      await sleep(60_000, undefined, { ref: false, signal: this.nudge.signal }).catch(() => undefined);
    }
    if (code && paired?.pairing !== (await pairingId(code))) {
      this.problem = 'Waiting for you to approve this agent in WebChat, in the window that shows the code.';
      paired = await AgentClient.pair(pairedFile, server, code, undefined, await this.offered());
    }
    // The laptop's own copy, whose cursor starts now, so messages from before it are history (D-094).
    // Paired just now, or loaded: with neither a file nor a code, start returned above.
    let client = await AgentClient.load(this.file('account.json')).catch(() => null);
    const fresh = !client || client.pairing !== paired!.pairing;
    if (!client || fresh) client = await paired!.copyTo(this.file('account.json'));
    this.client = client;
    client.protocol = AGENT_LEVEL.answers | AGENT_LEVEL.setup;
    this.setup = JSON.parse(await fs.readFile(this.file('setup.json'), 'utf8').catch(() => 'null')) ?? this.setup;
    await this.refreshHarnesses();
    // Only an approved pairing links anything, and a new one replaces the list. An agent paired before
    // linking runs what it found, minus what its owner turned off, and a harness installed later stays unlinked.
    if (fresh && paired!.picked) this.setup.choice.linked = paired!.picked;
    else if (!this.setup.choice.linked) this.setup.choice.linked = this.harnesses.filter((h) => h.path && !this.setup.choice.off?.includes(h.name)).map((h) => h.name);
    await this.saveSetup();
    this.runs = new Runs(client, (job) => this.run(job), (run) => this.cardRefusal(run), (taken, why) => this.abandon(taken, why));
    this.conversations = new Conversations(client, this.file('conversations.json'), (job) => this.converse(job), (conversation) => this.endSession(conversation.session), (scratch) => this.bench.drop(scratch));
    this.permits = new Permits(client, (message) => this.ownersOwn(message));
    await this.conversations.load();
    this.watched = JSON.parse(await fs.readFile(this.file('pulls.json'), 'utf8').catch(() => '[]')) as Watched[];
    this.plans = JSON.parse(await fs.readFile(this.file('plans.json'), 'utf8').catch(() => '[]')) as Planned[];
    this.copies = JSON.parse(await fs.readFile(this.file('boards.json'), 'utf8').catch(() => '{}')) as Record<number, BoardCopy>;
    // Sessions from before R-036 watched their drafts in each repository's folder.
    const old = (await fs.readdir(path.join(dataDir, 'repos')).catch(() => [] as string[])).map((name) => path.join(dataDir, 'repos', name, 'pulls.json'));
    for (const file of old) this.watched.push(...(JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]')) as Watched[]));
    await this.saveWatched();
    for (const file of old) await fs.rm(file, { force: true });
    await this.scan();
    this.problem = '';
    return true;
  }

  /**
   * Reads the marks: each folder the owner connected or had cloned, while it is still a checkout of
   * its repository, which every check-in names (R-036). The server learns names, never a path.
   */
  async scan() {
    const { dataDir } = this.options;
    const names = await fs.readdir(path.join(dataDir, 'repos')).catch(() => [] as string[]);
    const marks = await Promise.all(names.map(async (name) => ({ repo: name.replace('__', '/'), dir: await fs.readFile(path.join(dataDir, 'repos', name, 'connected'), 'utf8').catch(() => '') })));
    const found = await this.bench.folders(marks.filter((m) => m.dir));
    this.folders = new Map(found.map((f) => [f.repo.toLowerCase(), f] as const));
    this.client!.repos = [...this.folders.keys()];
    // A folder the owner connected in another process lets the runs and turns that wait for it go on.
    for (const key of this.waiting.keys()) if (this.folders.has(key)) this.settle(key);
  }

  /** The folder of a repository, whatever the case of its name: GitHub ignores it. */
  private folderOf(repo: string) {
    return this.folders.get(repo.toLowerCase());
  }

  /** Why every question, run and fix fails before it starts, or undefined. */
  private async refusal() {
    // Going to sleep: what runs finishes, and nothing new starts (K-66, D-113).
    if (existsSync(this.asleep)) return `I am going to sleep, so I start nothing new. To wake me, ${WAKE}.`;
    return this.noHarness();
  }

  /** Looks for the harnesses again, which hands a new adapter the owner's choice. */
  private async refreshHarnesses() {
    this.harnesses = await this.bench.harnesses();
  }

  /** The harnesses a new pairing asks to link, for the owner's approval: every one the laptop has that is not known to be signed out. */
  private async offered(): Promise<PairingPick[]> {
    await this.refreshHarnesses();
    return this.harnesses.flatMap(({ name, path: where, version, signedIn }) => (where && signedIn !== false ? [{ name, ...(version && { version }), ...(signedIn !== undefined && { signedIn }) }] : []));
  }

  /** Whether the owner linked a harness and has not turned it off, as an older page does. */
  private isLinked(harness: HarnessInfo) {
    const { linked = [], off = [] } = this.setup.choice;
    return linked.includes(harness.name) && !off.includes(harness.name);
  }

  /** The harnesses the owner linked, in the order they linked them. */
  private linkedHarnesses() {
    return (this.setup.choice.linked ?? []).flatMap((name) => this.harnesses.filter((h) => h.name === name && this.isLinked(h)));
  }

  /** Why a harness starts nothing: the owner turned it off or never linked it, or its laptop cannot run it. */
  private harnessRefusal(harness: HarnessInfo) {
    if (this.setup.choice.off?.includes(harness.name)) return `You turned ${harness.name} off, so I start nothing with it. Link it in my settings under Coding agents.`;
    if (!this.isLinked(harness)) return `You have not linked ${harness.name}, so I start nothing with it. Link it in my settings under Coding agents.`;
    return this.bench.refusal(harness.name);
  }

  /** Why no linked harness takes turns, or undefined while one does. With none linked, `every` would say all is well. */
  private async noHarness() {
    const linked = this.linkedHarnesses();
    if (!linked.length) return NONE_LINKED;
    const refusals = await Promise.all(linked.map((h) => this.harnessRefusal(h)));
    return refusals.every(Boolean) ? refusals[0] : undefined;
  }

  /**
   * The harness a request names, or the first linked for one from before the pick, such as a Check
   * again or a proposal's draft, and why it starts nothing, when it does. Picked once per run or
   * turn, and the harness goes on by name from there.
   */
  private async pick(name?: string): Promise<{ harness?: HarnessInfo; refused?: string }> {
    const harness = name === undefined ? this.linkedHarnesses()[0] : this.harnesses.find((h) => h.name === name);
    if (!harness) return { refused: name === undefined ? NONE_LINKED : `I have no ${name} on this laptop. Pick another coding agent.` };
    return { harness, refused: await this.harnessRefusal(harness) };
  }

  /** The harness a request names, which takes its turns; throws why it starts nothing, which the request's failure says. */
  private async harnessFor(name?: string) {
    const { harness, refused } = await this.pick(name);
    if (refused) throw new Error(refused);
    return harness!;
  }

  /** Whether a folder is one the agent may work in, with a harness linked to work there. */
  private usable(folder: Folder) {
    return !this.folderRefusal(folder) && this.linkedHarnesses().length > 0;
  }

  /** Why the work in one folder fails before it starts, or undefined (D-097). */
  private folderRefusal(folder: Folder) {
    // A harness's shell reads the repository's .git, where an https address can hold a login.
    if (/^https?:\/\/[^/]*@/i.test(folder.origin)) return `The address of ${folder.repo} on this laptop holds a password, which I must not see. Take the login out of the address of origin there.`;
  }

  /** Why its runs fail before they start, which Runs asks before each claim: they also push and open drafts with this laptop's GitHub login (D-092). */
  private async cardRefusal(run?: RunRequest) {
    // A page from before R-030 names no repository, and nothing says where to run.
    if (run && !run.repo) return 'Reload WebChat, then open the card again and press Start.';
    const refused =
      (await this.refusal()) ??
      (run && (await this.pick(run.harness)).refused) ??
      ((await signedIn()) ? undefined : 'Cards need the agent’s GitHub sign-in. Run `webchat-agent setup` and answer yes to its GitHub question.');
    if (refused || !run) return refused;
    // A card that an open pull request claims is taken, as `scripts/claim.sh` refuses it (R-042).
    // A card also waits for the cards its After line names, as its owner's page shows (docs/roadmap/new-after-edge.md).
    const [open, found] = await Promise.all([openPulls(run.repo!, 'number,title,body,headRefName'), this.boardCard(run)]);
    const claim = open?.find((p) => claimOf(p) === cardKey(run.card));
    if (claim) return `${run.repo}#${claim.number} claims ${run.card} already. Pick another card, or ask whoever opened it.`;
    const waits = found?.card.waits;
    return waits && `${run.card} waits for ${waits.on.join(', ')}, which must be Done or Fixed first. Start it once they are.`;
  }

  /**
   * The folder of a repository. When the laptop has none, says so with `offer`, which the owner
   * answers by having it cloned, and waits for that: at most 30 minutes, or until a cancel (R-036).
   */
  private async folderFor(repo: string, signal: AbortSignal, offer: () => Promise<unknown>) {
    if (!this.folderOf(repo)) {
      await offer();
      const key = repo.toLowerCase();
      const stop = AbortSignal.any([signal, AbortSignal.timeout(CLONE_WAIT_MS)]);
      await new Promise<void>((resolve, reject) => {
        const waiters = this.waiting.get(key) ?? new Set();
        const done = () => (waiters.delete(waiter), stop.removeEventListener('abort', aborted));
        const waiter = { resolve: () => (done(), resolve()), reject: (error: Error) => (done(), reject(error)) };
        const aborted = () => waiter.reject(new Error(signal.aborted ? 'the owner cancelled the run.' : `Nobody had me clone ${repo} within 30 minutes.`));
        this.waiting.set(key, waiters.add(waiter));
        stop.addEventListener('abort', aborted, { once: true });
      });
    }
    const folder = this.folderOf(repo)!;
    const refused = this.folderRefusal(folder);
    if (refused) throw new Error(refused);
    return folder;
  }

  /** Lets the runs and turns that wait for a repository's folder go on, or fail with the error. */
  private settle(key: string, error?: Error) {
    for (const waiter of [...(this.waiting.get(key) ?? [])]) (error ? waiter.reject(error) : waiter.resolve());
    this.waiting.delete(key);
  }

  /** Checks in every 15 seconds, every minute once an hour passed with nothing to do, and looks at the pull requests every minute, until the session ends the process or the agent goes to sleep. */
  async loop() {
    // First, so a sleep among the messages missed while away ends the loop too.
    const stop = (this.stop = new AbortController());
    // Without a runner the check-ins stop and the watch is free, until `start` finds one again.
    const gone = () => (stop.abort(), freeLock(path.join(this.options.dataDir, 'watch.lock')));
    this.lost?.aborted ? gone() : this.lost?.addEventListener('abort', gone, { once: true });
    this.lastWork = Date.now();
    const missed = await this.client!.sync().catch((error: unknown) => (log(error), []));
    await this.endStrandedDrafts().catch(log);
    await this.runs!.recover().catch(log);
    await this.conversations!.recover().catch(log);
    missed.forEach((m) => this.handle(m));
    await this.updateLevel();
    // Another process may connect a folder meanwhile, a folder may move, and another process may put the agent to sleep.
    const timers = [
      setInterval(() => {
        this.drowse();
        void this.scan().catch(log);
        void this.sendAsks().catch(log);
      }, SYNC_INTERVAL_MS),
      setInterval(() => {
        void this.refreshHarnesses().then(() => this.updateLevel()).then(() => this.pollPulls()).catch(log);
        void this.conversations!.sweep().catch(log);
        this.permits!.sweep(new Set([...this.watched, ...this.plans].flatMap((p) => (p.session ? [p.session] : []))));
        void this.syncBoards().catch(log);
      }, 60_000),
    ];
    const every = () => {
      if (this.busy().length) this.lastWork = Date.now();
      return checkInEvery(Date.now() - this.lastWork);
    };
    try {
      for await (const message of this.client!.watch(this.stop.signal, every)) this.handle(message);
    } finally {
      timers.forEach(clearInterval);
    }
  }

  /**
   * What the check-in names: the union over the linked harnesses, so cards need one that takes
   * them, and the GitHub sign-in. Answers and setup stay set with none linked, or Settings, the
   * only place to link one, would stay shut.
   */
  private async updateLevel() {
    const asks = this.linkedHarnesses().some((h) => h.asks) ? AGENT_LEVEL.asks : 0;
    const own = this.linkedHarnesses().some((h) => h.offers.knobs.includes('own')) ? AGENT_LEVEL.own : 0;
    // A terminal's session goes on only in the owner's own setup, so the adapters that run it list them.
    const sessions = own ? AGENT_LEVEL.sessions : 0;
    this.client!.protocol = AGENT_LEVEL.answers | AGENT_LEVEL.setup | AGENT_LEVEL.events | AGENT_LEVEL.controls | AGENT_LEVEL.anywhere | asks | own | sessions | ((await signedIn()) && !(await this.noHarness()) ? AGENT_LEVEL.cards : 0);
  }

  /** The work that keeps an agent awake while it goes to sleep: its running cards and questions. */
  private busy() {
    return [...this.runs!.running.map((r) => r.card), ...(this.conversations!.busy ? ['your question'] : [])];
  }

  /**
   * Goes to sleep once the switch is on and nothing runs: the check-ins stop, so the page shows the
   * agent asleep, and the watch is free for no process while the switch stays on (K-66, D-113).
   */
  private drowse() {
    if (!this.stop || this.stop.signal.aborted || !existsSync(this.asleep) || this.busy().length) return;
    this.stop.abort();
    freeLock(path.join(this.options.dataDir, 'watch.lock'));
    this.problem = this.asleepWords;
  }

  /** Turns the switch on, and says what still runs before the agent sleeps. */
  private async sleep() {
    await fs.mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.asleep, '');
    this.drowse();
    return this.working();
  }

  /** What a restart would cut short, for the updater and for `sleep`. Only the process that serves knows; another one goes to sleep at its next check. */
  async working() {
    return this.runs ? this.busy() : [];
  }

  /** Turns the switch off; the process waiting here serves at once, any other within a minute. */
  async wake() {
    if (!existsSync(this.asleep)) return 'Your agent is not asleep.';
    await fs.rm(this.asleep, { force: true });
    this.nudge?.abort();
    return 'Your agent is waking up. It takes cards and answers questions again within a minute.';
  }

  /** Goes to sleep on its owner's word in the pane, after the work that runs, and says so there (K-66, D-113). */
  private async sleepOnWord(message: OpenedMessage) {
    if (!this.fromOwner(message, message.content!.sleep!.sentAt)) return;
    const busy = await this.sleep();
    const when = busy.length ? `once I finish ${busy.join(' and ')}` : 'now';
    await this.client!.send(message.conversationId, { text: `I go to sleep ${when}. To wake me, ${WAKE}.` });
  }

  private saveCopies() {
    return fs.writeFile(this.file('boards.json'), JSON.stringify(this.copies, null, 2));
  }

  /**
   * Answers its owner's ask to link a board to a repository with the repository's entries, for their
   * page to import once (R-040, D-117): its docs as the default branch has them, with the entries
   * not folded in yet, in parts that each fit a message. Those files count as proposals handled, so
   * the first copy drops them.
   */
  private async linkOnWord(message: OpenedMessage) {
    const ask = message.content!.board as Extract<BoardSyncDTO, { kind: 'link' }>;
    if (!this.fromOwner(message, ask.sentAt)) return;
    const to = message.clientId!;
    const folder = this.folderOf(ask.repo);
    if (!folder || !this.usable(folder)) {
      const text = `${noCopy(ask.repo)} Ask me about it under Coding agents, and I offer to clone it.`;
      return void (await this.client!.send(message.conversationId, { text, board: { kind: 'failed', to } }));
    }
    const { ref } = await this.keep.fetch(ask.repo);
    const entries = new Map<string, string>();
    const handled: BoardCopy['proposals'] = {};
    for (const { path: file, blob } of await this.keep.docFiles(ask.repo, ref)) {
      // A proposal named by a short name stays one; an entry not folded in yet is named by its id (D-106).
      const pending = !/\/(roadmap|decisions)\.md$/.test(file);
      if (pending && !/\/[DRKQ]-\d+\.md$/.test(file)) continue;
      for (const entry of entriesOf(file.startsWith('docs/decisions') ? 'decisions' : 'roadmap', await this.keep.show(ask.repo, blob))) entries.set(readCard(entry)!.id, entry);
      if (pending) handled[file] = { blob, draft: '', added: true };
    }
    this.copies[ask.project] = { repo: ask.repo, seen: '', moved: Date.now(), proposals: handled };
    await this.saveCopies();
    const parts = inParts([...entries.values()]);
    for (const [i, part] of parts.entries()) {
      await this.client!.send(message.conversationId, { text: `The entries of ${ask.repo}, part ${i + 1} of ${parts.length}`, board: { kind: 'entries', to, part: i + 1, parts: parts.length, entries: part } });
    }
  }

  /** The owner's direct chat with this agent, where they send what the agent acts on. */
  private ownerChat() {
    const client = this.client!;
    return [...client.conversations.values()].find((c) => c.type === 'direct' && c.members.some((m) => m.userId === client.owner))?.id;
  }

  /**
   * Files a request, from `webchat-agent link` or `connect`, for the serving agent to send its owner:
   * a file, since the account belongs to the serving process, which this command must not race.
   */
  private async fileAsk(filed: Filed) {
    const dir = path.join(this.options.dataDir, 'asks');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ ...filed, at: Date.now() }));
  }

  /** Returns what to tell the one who typed `webchat-agent link`. */
  async requestLink(name: string) {
    const stored = JSON.parse(await fs.readFile(this.file('setup.json'), 'utf8').catch(() => 'null')) as { choice?: SetupChoice } | null;
    if (stored?.choice?.linked?.includes(name) && !stored.choice.off?.includes(name)) return `${name} is linked already.`;
    await this.fileAsk({ kind: 'link', harness: name });
    return `Asked your agent to link ${name}. Approve it in WebChat under Coding agents, within 10 minutes. The agent must be running: see \`webchat-agent status\`.`;
  }

  /**
   * Asks the owner to connect this folder, for `webchat-agent connect`: it marks nothing, and the
   * serving agent does when the owner approves in WebChat (docs/decisions/connect-approval.md).
   */
  async requestConnect(dir: string, repo: string) {
    const { dataDir } = this.options;
    if (!existsSync(path.join(dataDir, 'account.json'))) return 'This agent is not paired, so there is no owner to ask. Pair first: see `webchat-agent setup`.';
    if ((await fs.readFile(markOf(dataDir, repo), 'utf8').catch(() => '')) === dir) return `${repo} is connected to this folder already.`;
    await this.fileAsk({ kind: 'connect', repo, dir });
    return `Asked your agent's owner to connect ${repo} in ${shown(dir)}. They approve it in WebChat under Coding agents, within 10 minutes; nothing changes until then. The agent must be running: see \`webchat-agent status\`.`;
  }

  /**
   * Sends the owner each request the commands filed, as a sealed `ask` in their direct chat, and
   * keeps what it asked by the message's client id. A stale file, a harness already linked, a
   * folder that no longer pushes to its repository or is connected already, and a second request for
   * what waits are dropped. Only a harness this agent supports gets through, as the file's text
   * never reaches the page.
   */
  async sendAsks() {
    const dir = path.join(this.options.dataDir, 'asks');
    const chat = this.ownerChat();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    if (!names.length || chat === undefined) return;
    const asks = (this.setup.asks ??= {});
    const now = Date.now();
    for (const [id, ask] of Object.entries(asks)) if (now - ask.at > 60 * 60_000) delete asks[id];
    for (const name of names) {
      const file = path.join(dir, name);
      const filed = JSON.parse(await fs.readFile(file, 'utf8').catch(() => 'null')) as Filed | null;
      await fs.rm(file, { force: true });
      if (typeof filed?.at !== 'number' || now - filed.at > REQUEST_TTL_MS) continue;
      const what = filed.kind === 'link' ? this.harnesses.find((h) => h.name === filed.harness && !this.isLinked(h))?.name : filed.kind === 'connect' ? await this.connectable(filed) : undefined;
      if (!what || Object.values(asks).some((a) => a.kind === filed.kind && a.what.toLowerCase() === what.toLowerCase() && now - a.at <= REQUEST_TTL_MS)) continue;
      const [text, ask]: [string, AskDTO] =
        filed.kind === 'link'
          ? [`Link ${what} on this laptop? Approve or decline it in WebChat, under Coding agents.`, { kind: 'link', step: 'request', harness: what }]
          : [`Connect ${what} in ${shown(filed.dir)}? Approve or decline it in WebChat, under Coding agents.`, { kind: 'connect', step: 'request', repo: what, folder: shown(filed.dir) }];
      const sent = await this.client!.send(chat, { text, ask });
      asks[sent.clientId!] = { kind: filed.kind, what, ...(filed.kind === 'connect' && { dir: filed.dir }), at: now } as Asked;
      await this.keepSetup();
    }
  }

  /** The repository a connect request names, when its folder is still a checkout of it and not marked yet. */
  private async connectable(filed: Extract<Filed, { kind: 'connect' }>) {
    const { repo } = await this.bench.checkout(filed.dir);
    if (repo?.toLowerCase() !== String(filed.repo).toLowerCase()) return;
    return (await fs.readFile(markOf(this.options.dataDir, repo), 'utf8').catch(() => '')) === filed.dir ? undefined : repo;
  }

  /**
   * Acts on the owner's answer to a request this agent sent: what it recorded, never a name from the
   * message, except that a connect's approval must repeat the repository and folder the owner saw.
   * Only the owner's word counts, once (D-089, K-47), and a request answers only within 10 minutes
   * of its sending. A decline changes nothing.
   */
  private async askOnWord(message: OpenedMessage) {
    const { ask } = message.content!;
    if (!message.clientId || !ask || (ask.step !== 'approve' && ask.step !== 'decline') || !this.fromOwner(message, ask.sentAt)) return;
    const asked = this.setup.asks?.[ask.to];
    if (asked?.kind !== ask.kind) return;
    delete this.setup.asks![ask.to];
    const dir = asked.dir ?? '';
    const send = (text: string, step: 'done' | 'failed') => this.client!.send(message.conversationId, { text, ask: { kind: asked.kind, step, to: ask.to } });
    const again = `Run \`webchat-agent ${asked.kind}\` again.`;
    const stale = Date.now() - asked.at > REQUEST_TTL_MS;
    const changed = ask.step === 'approve' && ask.kind === 'connect' && (ask.repo !== asked.what || ask.folder !== shown(dir));
    if (stale || changed) await send(stale ? `That request is older than 10 minutes. ${again}` : `That approval names another repository or folder than the request did, so I connect nothing. ${again}`, 'failed');
    const approved = ask.step === 'approve' && !stale && !changed;
    const harness = approved && asked.kind === 'link' && this.harnesses.find((h) => h.name === asked.what);
    if (harness) {
      const { linked = [], off = [] } = this.setup.choice;
      this.setup.choice = { ...this.setup.choice, linked: [...linked.filter((n) => n !== harness.name), harness.name], off: off.filter((n) => n !== harness.name) };
    }
    await this.saveSetup();
    if (harness) {
      await this.updateLevel();
      await send(`Linked ${harness.name}.`, 'done');
      await this.sendSetupState(message.conversationId, message.clientId);
    } else if (approved && asked.kind === 'connect') {
      // The folder may have moved or changed its origin since it asked.
      if ((await this.bench.checkout(dir)).repo?.toLowerCase() !== asked.what.toLowerCase()) return void (await send(`${shown(dir)} is no longer a checkout of ${asked.what}, so I connect nothing. ${again}`, 'failed'));
      await this.mark(asked.what, dir);
      await send(`Connected ${asked.what}: I work in ${shown(dir)}.`, 'done');
    }
  }

  /** Notes that its owner added a proposal's draft to the board, so the next copy drops its file (R-040). */
  private async proposalAdded(message: OpenedMessage) {
    if (!this.ownersOwn(message)) return;
    const proposals = Object.values(this.copies).flatMap((c) => Object.values(c.proposals));
    const { draft, card } = message.content!.added!;
    for (const proposal of proposals) if (proposal.draft === draft) proposal.added = true;
    this.adding.get(draft)?.(card);
    await this.saveCopies();
  }

  /**
   * Sends a proposal from a session's working tree as a card draft, for `webchat-agent card`, and
   * waits for the number the board gives it (R-044). The draft goes through the agent's check first,
   * as every draft does (D-116), and only the owner's click adds it (D-104). The command sends the
   * file's text, since the keyholder may not read the owner's folders.
   */
  async requestCard(repo: string, file: string, text: string, waitMs = CARD_WAIT_MS): Promise<{ text: string; card?: string }> {
    const client = this.client;
    const chat = this.ownerChat();
    if (!client || !this.runs || chat === undefined) throw new Error(`Your agent is not serving, so it cannot send the draft. ${this.problem}`);
    const folder = this.folderOf(repo);
    if (!folder || !this.usable(folder)) throw new Error(`${noCopy(repo)} Connect it first: see \`webchat-agent connect\`.`);
    const project = Number(Object.entries(this.copies).find(([, c]) => c.repo.toLowerCase() === repo.toLowerCase())?.[0]);
    if (!project) throw new Error(`No board in WebChat is linked to ${repo}, so nothing can number a card. Merge the file as a proposal instead.`);
    const proposal = proposalOf(file, text);
    if (!proposal) throw new Error('That file holds no card: it starts with a heading such as `### R: Title`.');
    if (proposal.id) throw new Error(`That file changes ${proposal.id}, which has its number: merge it as a proposal.`);
    // A draft is an idea, an issue or a decision; a question has no draft (D-104).
    const kind = ({ R: 'idea', K: 'issue', D: 'decision' } as const)[proposal.kind as 'R' | 'K' | 'D'];
    if (!kind) throw new Error('A question goes on the board as a file: merge it as a proposal.');
    const conversation: Conversation = { root: randomUUID(), chat, repo, project, session: randomUUID(), answered: false, last: Date.now() };
    const input = [
      `Your owner wrote this card in a terminal session and wants it on the board. Check it, then put it in drafts as one new ${kind},`,
      'with its title and body as written: change them only where the check finds something wrong, and say what in reply. When it should',
      'not go on the board, as it repeats an open card, goes against a decision or asks for what the code does, draft nothing and say why in reply.',
      'When the check splits it, as for a change to a contract, draft the contract card first and the card after it second.',
      '',
      fence('The card', [text.trim()], [OWNER, "OWNER'S WORDS"]),
    ].join('\n');
    const answer = await this.converse({ conversation, input, resume: false, signal: new AbortController().signal }).finally(() => {
      this.endSession(conversation.session);
      if (conversation.scratch) void this.bench.drop(conversation.scratch).catch(log);
    });
    // A split is two drafts: the contract card, whose number the command waits for, then the card after it (docs/roadmap/new-after-edge.md).
    const [draft, then] = answer.drafts?.filter((d) => !d.replaces) ?? [];
    if (!draft) throw new Error(`Your agent drafted no card: ${answer.reply.trim() || 'it gave no reason.'}`);
    const sent = await client.send(chat, { text: `Proposed in ${repo}: ${file}`, board: { kind: 'proposal', project, repo, card: draft } });
    const split = then?.after === draft.title ? ` Your agent split it: “${then.title}” waits on the board until it is done.` : '';
    if (split) await client.send(chat, { text: `Proposed in ${repo}: ${file}, after ${draft.title}`, board: { kind: 'proposal', project, repo, card: then! } });
    const card = await new Promise<string | undefined>((resolve) => {
      this.adding.set(sent.clientId!, resolve);
      setTimeout(() => resolve(undefined), waitMs).unref();
    }).finally(() => this.adding.delete(sent.clientId!));
    const said = answer.reply.trim() ? `\n\nYour agent's check: ${answer.reply.trim()}` : '';
    if (!card) return { text: `The draft waits in WebChat under Coding agents; once your owner adds it, the board shows its number.${split}${said}` };
    return { text: `Your owner added ${card}. Claim it with scripts/claim.sh, and leave ${file} out of the pull request.${split}${said}`, card };
  }

  /**
   * Keeps each linked board's repository docs as its copy, for the projects its owner owns (R-040,
   * D-117). Once a board stayed unchanged for 10 minutes, it renders both columns and commits them
   * to `agent/board`, in one draft pull request it keeps open; it never pushes main and never
   * forces (D-092). It also sends each proposal file the default branch gained as a card draft, and
   * names the cards that open pull requests claim, whose status the owner's page then sets. A
   * repository that two boards link copies only the first.
   */
  async syncBoards(now = Date.now()) {
    const client = this.client!;
    const chat = this.ownerChat();
    if (this.copying || chat === undefined || (await this.refusal())) return;
    this.copying = true;
    const before = JSON.stringify(this.copies);
    try {
      const taken = new Set<string>();
      for (const project of client.projects) {
        if (project.ownerId !== client.owner || !project.memberIds.includes(client.id)) continue;
        const docs = await client.boardDocs(project.id);
        const title = docs.roadmap?.title;
        // Only the project's owner links its board (R-040).
        const repo = title?.authorId === client.owner ? (await client.openDoc(docs.roadmap!, title))?.repo : undefined;
        if (!repo || taken.has(repo.toLowerCase())) continue;
        taken.add(repo.toLowerCase());
        let copy = this.copies[project.id];
        if (copy?.repo !== repo) copy = this.copies[project.id] = { repo, seen: '', moved: now, proposals: {} };
        // The members are in it too, as who is among them decides which statuses stand.
        const versions = `${docs.roadmap!.version}:${docs.decisions?.version ?? 0}:${project.memberIds.join()}`;
        if (versions !== copy.seen) Object.assign(copy, { seen: versions, moved: now });
        const due = copy.moved > 0 && now - copy.moved >= 10 * 60_000;
        // Origin and GitHub are looked at every 5 minutes, or when a copy is due.
        if (!due && now - (this.looked.get(project.id) ?? 0) < 5 * 60_000) continue;
        const folder = this.folderOf(repo);
        if (!folder || !this.usable(folder) || !(await signedIn())) continue;
        this.looked.set(project.id, now);
        const { roadmap, decisions } = await this.columns(project, versions, docs);
        const { ref } = await this.keep.fetch(repo);
        await this.sendClaims(project.id, copy, roadmap, chat);
        if (due) {
          await this.pushCopy(copy, ref, { roadmap: copyOf('roadmap', roadmap.map((c) => c.stands)), decisions: copyOf('decisions', decisions.map((c) => c.text)) });
          copy.moved = 0;
        }
        // Last, as a backlog of them can take the round long and run into the send limit (K-71).
        await this.sendProposals(project.id, copy, ref, [...roadmap, ...decisions], chat);
      }
    } finally {
      this.copying = false;
      if (JSON.stringify(this.copies) !== before) await this.saveCopies();
    }
  }

  /** A board's cards, read again only when a column changed: each read fetches and opens every card (R-040). */
  private async columns(project: ProjectDTO, versions: string, docs: { roadmap?: DocDTO; decisions?: DocDTO }) {
    const kept = this.cards.get(project.id);
    if (kept?.versions === versions) return kept;
    const [roadmap, decisions] = await Promise.all([this.roadmapOf(project, docs.roadmap), this.cardsOf(docs.decisions)]);
    this.cards.set(project.id, { versions, roadmap, decisions });
    return { roadmap, decisions };
  }

  /**
   * The Roadmap's cards as every page reads them (the card-owner decision), without the ones whose
   * removal stands: each with its text as written, which a draft's hash reads (D-105), and the text
   * that stands, which the copy writes.
   */
  private async roadmapOf(project: ProjectDTO, doc?: DocDTO) {
    if (!doc) return [];
    return (await this.roadmapCards(project, await this.client!.cardSections(doc).catch(() => []))).map((c) => ({ doc: doc.id, section: c.id, text: c.written.trim(), stands: c.text.trim() }));
  }

  /** The Roadmap's cards from their sections, with each card's owner and every member's word on it, as every page reads them. */
  private roadmapCards(project: ProjectDTO, sections: DocSection[]) {
    const client = this.client!;
    return cardsOf(sections, project.memberIds, usernamesOf(project.memberIds, Object.fromEntries(client.users), null));
  }

  /** A column's cards, each with its place, or none for a column that does not open. */
  private async cardsOf(doc?: DocDTO) {
    return doc ? (await this.client!.sections(doc).catch(() => [])).map((s) => ({ doc: doc.id, section: s.id, text: s.text.trim() })) : [];
  }

  /**
   * Sends each proposal file the default branch gained under `docs/roadmap/` or `docs/decisions/` as
   * a card draft, once per version of the file (R-040). A change names its card on the board, with
   * the hash of its text, as an agent's draft does (D-104). A new card whose title the board has
   * already came to the board, though this laptop's record may not know it (K-71). The sends are
   * paced under the server's limit, and one it refuses anyway leaves the rest to the next round.
   */
  private async sendProposals(project: number, copy: BoardCopy, base: string, cards: Array<{ doc: string; section: string; text: string }>, chat: number) {
    const titleOf = (title: string) => title.trim().toLowerCase();
    const titles = new Set(cards.flatMap((c) => readCard(c.text)?.title ?? []).map(titleOf));
    let sent = 0;
    for (const { path: file, blob } of await this.keep.docFiles(copy.repo, base)) {
      if (/\/(roadmap|decisions)\.md$/.test(file) || copy.proposals[file]?.blob === blob || this.skipped.has(`${file}:${blob}`)) continue;
      const proposal = proposalOf(file, await this.keep.show(copy.repo, blob));
      const card = proposal?.id ? cards.find((c) => readCard(c.text)?.id === proposal.id) : undefined;
      // A change to a card the board does not have stays a file, as nothing could take it.
      if (!proposal || (proposal.id && !card) || (!proposal.id && titles.has(titleOf(proposal.title)))) {
        this.skipped.add(`${file}:${blob}`);
        continue;
      }
      const draft: CardDraftDTO = {
        kind: proposal.kind,
        title: proposal.title,
        body: proposal.body,
        ...(card && { replaces: { card: proposal.id!, doc: card.doc, section: card.section, seen: await textHash(card.text) } }),
        ...(card && proposal.status && { status: proposal.status }),
      };
      if (sent++) await sleep(SEND_GAP_MS);
      try {
        const message = await this.client!.send(chat, { text: `Proposed in ${copy.repo}: ${file}`, board: { kind: 'proposal', project, repo: copy.repo, card: draft } });
        copy.proposals[file] = { blob, draft: message.clientId! };
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429) throw error;
        return log(error);
      }
    }
  }

  /**
   * Names the cards that open pull requests claim, as `claimOf` reads them, so the owner's page sets
   * them Running, as it sets a run's status (R-040, D-100).
   */
  private async sendClaims(project: number, copy: BoardCopy, cards: Array<{ text: string }>, chat: number) {
    const pulls = await openPulls(copy.repo, 'number,title,body,headRefName');
    if (!pulls) return;
    // By kind and number, as an id may be padded, such as R-005.
    const ids = new Map<string, string>(
      cards.flatMap((c) => {
        const card = readCard(c.text);
        return card ? [[cardKey(card.id), card.id] as const] : [];
      }),
    );
    const claims = pulls.flatMap((p) => {
      const card = ids.get(claimOf(p) ?? '');
      return card ? [{ card, pull: p.number }] : [];
    });
    if (JSON.stringify(claims) === copy.claims) return;
    const text = `Open pull requests in ${copy.repo} claim ${claims.map((c) => `${c.card} (#${c.pull})`).join(', ') || 'no card'}.`;
    await this.client!.send(chat, { text, board: { kind: 'claims', project, repo: copy.repo, claims } });
    copy.claims = JSON.stringify(claims);
  }

  /**
   * Writes the board's copy on `agent/board`: from the branch as origin has it, with the default
   * branch merged in, so the push never forces (D-092). The files of proposals the owner added go,
   * as the board holds them now. Keeps one draft pull request open on it, which the owner merges.
   * It is made in the agent's own clone with no checkout: the repository's files never run or write here.
   */
  private async pushCopy(copy: BoardCopy, base: string, files: { roadmap: string; decisions: string }) {
    const remove = Object.entries(copy.proposals).flatMap(([file, proposal]) => (proposal.added ? [file] : []));
    const made = await this.keep.commitFiles(copy.repo, { branch: BOARD_BRANCH, base, files: { 'docs/roadmap.md': files.roadmap, 'docs/decisions.md': files.decisions }, remove, message: 'docs: Copy the board' });
    if (made) await this.keep.push(copy.repo, BOARD_BRANCH);
    const open = JSON.parse(await gh(['pr', 'list', '--repo', copy.repo, '--head', BOARD_BRANCH, '--state', 'open', '--json', 'number'])) as unknown[];
    if (open.length || !(await this.keep.ahead(copy.repo, base, BOARD_BRANCH))) return;
    const body = 'The board of this project in WebChat, which its owner’s agent copies here. Merge it to update `docs/roadmap.md` and `docs/decisions.md`. The agent pushes each later change of the board to this branch.';
    await this.openDraft(BOARD_BRANCH, base, 'docs: Copy the board', body, copy.repo);
  }

  /** Acts on one message. A turn takes long, so the loop does not wait for it: check-ins go on meanwhile. */
  handle(message: OpenedMessage) {
    this.lastWork = Date.now();
    const { run, prompt } = message.content ?? {};
    if (run?.kind === 'fix') return this.go(message, run).catch(log);
    if (run?.kind === 'clone' || prompt?.kind === 'clone') return this.clone(message).catch(log);
    if (message.content?.forget) return this.forget(message).catch(log);
    if (message.content?.sleep) return this.sleepOnWord(message).catch(log);
    if (message.content?.setup) return this.setupOnWord(message).catch(log);
    if (message.content?.sessions) return this.listSessions(message).catch(log);
    if (message.content?.ask) return this.askOnWord(message).catch(log);
    if (message.content?.permit) return this.permits!.answer(message).catch(log);
    if (message.content?.board?.kind === 'link') return this.linkOnWord(message).catch(log);
    if (message.content?.added) return this.proposalAdded(message).catch(log);
    return (prompt ? this.conversations! : this.runs!).handle(message).catch(log);
  }

  /**
   * Takes its owner's choice of what runs load from their Claude setup, when the message holds one,
   * and answers with what the laptop offers, the choice it keeps and what its last run or turn
   * loaded (R-039, D-115). Only the owner's word counts, as for a sleep. Skill names reach only
   * their direct chat, sealed.
   */
  private async setupOnWord(message: OpenedMessage) {
    const { setup } = message.content!;
    if (!this.fromOwner(message, setup!.sentAt)) return;
    if (setup!.choice) {
      // A page from before linking sends no list, and a page from before the off list sends none, so those stay as they were.
      this.setup.choice = { linked: this.setup.choice.linked, off: this.setup.choice.off, ...setup!.choice };
      await this.saveSetup();
      await this.updateLevel();
    }
    await this.sendSetupState(message.conversationId, message.clientId!);
  }

  /**
   * Answers its owner's ask for the sessions their terminal started in a connected folder, with the
   * first harness they linked that can go on with one in their own setup (R-072). The list is sealed
   * and quiet, like the board's traffic.
   */
  private async listSessions(message: OpenedMessage) {
    const { repo, sentAt } = message.content!.sessions!;
    if (!this.fromOwner(message, sentAt)) return;
    const folder = this.folderOf(repo);
    const harness = this.linkedHarnesses().find((h) => h.offers.knobs.includes('own') && this.setup.choice.own?.includes(h.name));
    const sessions = folder && this.usable(folder) && harness ? await this.bench.sessions(harness.name, folder.dir) : [];
    await this.client!.send(message.conversationId, { text: `${sessions.length} sessions in ${repo}`, sessionList: { to: message.clientId!, repo, harness: harness?.name ?? '', sessions } }, { kind: 'sync' });
  }

  /** Answers a `setup` with what the laptop offers, the choice it keeps, and what its last run or turn loaded. */
  private async sendSetupState(chat: number, to: string) {
    const { choice, applied } = this.setup;
    await this.refreshHarnesses();
    const [owner, ...states] = await Promise.all([this.bench.ownerSetup(), ...this.harnesses.map((h) => this.stateOf(h))]);
    await this.client!.send(chat, {
      text: `My runs load ${setupWords(choice)}.`,
      setupState: { to, ...owner, choice, ...(applied && { applied }), harnesses: states },
    });
  }

  /**
   * A harness as the owner's Settings shows it (D-115): where the laptop has it, whether it is
   * linked, what needs the owner's attention, whether it takes cards, and what it offers. A sandbox
   * that lets its shell read the owner's secrets is a warning there. `refusal` names not-linked too,
   * so a page from before linking greys it.
   */
  private async stateOf(harness: HarnessInfo): Promise<HarnessState> {
    const { instructions, skills, knobs, models } = harness.offers;
    const linked = this.isLinked(harness);
    const [own, refused] = await Promise.all([this.bench.refusal(harness.name), this.harnessRefusal(harness)]);
    const attention = linked ? own ?? (harness.signedIn === false ? `${harness.name} is not signed in.` : harness.warning) : undefined;
    return { name: harness.name, ...(harness.version && { version: harness.version }), ...(harness.signedIn !== undefined && { signedIn: harness.signedIn }), ...(harness.path && { path: shown(harness.path) }), linked, ...(attention && { attention }), answers: refused, refusal: refused, instructions: instructions && shown(instructions), skills: skills && shown(skills), knobs, ...(models && { models }) };
  }

  /** Keeps the setup on disk, and hands each harness its choice. */
  private async saveSetup() {
    await this.bench.apply(this.setup.choice);
    await this.keepSetup();
  }

  private keepSetup() {
    return fs.writeFile(this.file('setup.json'), JSON.stringify(this.setup));
  }

  /**
   * Clones a repository the laptop has no folder for, on its owner's signed request, then lets the
   * runs and turns that wait for it go on (R-036, D-108). Only one that a project of the owner's
   * links, only into the clone root, and with the owner's `gh` login: the background Claude never
   * reaches GitHub. Notes go where the owner pressed the button.
   */
  private async clone(message: OpenedMessage) {
    const client = this.client!;
    const { run, prompt } = message.content!;
    const chat = message.conversationId;
    // Notes go where the owner pressed the button: a note leaves the run or turn going, an end says
    // why nothing waits on it any more.
    const asked =
      run?.kind === 'clone'
        ? { ...run, again: 'Start the card again.', say: (text: string, end = false) => this.runs!.report({ message: run.request, conversation: chat, card: '' }, { kind: end ? 'failed' : 'claimed', note: text }, text) }
        : prompt?.kind === 'clone'
          ? { ...prompt, again: 'Reply to ask again.', say: (text: string, end = false) => client.send(chat, { text, prompt: { kind: end ? 'failed' : 'note', to: prompt.to } }) }
          : undefined;
    if (!asked || !this.fromOwner(message, asked.sentAt)) return;
    const { say } = asked;
    const key = asked.repo.toLowerCase();
    const fail = (text: string) => (this.waiting.get(key)?.size ? this.settle(key, new Error(text)) : say(text, true));
    if (this.folderOf(key)) return this.settle(key);
    if (this.cloning.has(key)) return;
    if (!isRepoName(asked.repo) || !(await this.linked(key))) return fail(`None of your projects links ${asked.repo}, so I do not clone it.`);
    if (!(await signedIn())) return fail('Cloning needs the agent’s GitHub sign-in. Run `webchat-agent setup` and answer yes to its GitHub question.');
    const [owner, name] = asked.repo.split('/') as [string, string];
    const dir = path.join(this.options.cloneRoot, owner, name);
    this.cloning.add(key);
    try {
      // A folder there already is used only when it is a checkout of this repository.
      const have = await this.bench.checkout(dir);
      if (have.exists) {
        if (have.repo?.toLowerCase() !== key) return await fail(`${shown(dir)} holds something else. Move it away, then ask again.`);
      } else {
        await say(`Cloning ${asked.repo} into ${shown(dir)}. This can take a while.`);
        // The agent's own clone is made first, and the folder from a bundle of it: the owner's account never fetches from GitHub.
        const { ref, tip } = await this.keep.fetch(asked.repo).catch((error: unknown) => {
          throw new Error(`I could not clone ${asked.repo}: ${messageOf(error).split('\n').find((l) => l.trim()) ?? 'git failed'}`);
        });
        await this.bundled(async (file) => {
          await this.keep.baseBundle(asked.repo, file, ref);
          await this.bench.clone(dir, asked.repo, file, ref);
        });
        this.sent.set(dir, tip);
      }
      const mark = markOf(this.options.dataDir, asked.repo);
      await fs.mkdir(path.dirname(mark), { recursive: true, mode: 0o700 });
      await fs.writeFile(mark, dir);
      // The scan lets what waits go on, so whether anything waited is read before it.
      const waited = !!this.waiting.get(key)?.size;
      await this.scan();
      if (!waited) await say(`Cloned ${asked.repo} into ${shown(dir)}. ${asked.again}`, true);
    } catch (error) {
      await fail(messageOf(error));
    } finally {
      this.cloning.delete(key);
    }
  }

  /** Whether a message is its owner's, in their direct chat, signed lately, and new (D-089, K-42, K-47). */
  private fromOwner(message: OpenedMessage, sentAt: number) {
    return this.ownersOwn(message) && this.client!.remember(message.clientId ?? '', sentAt) && Math.abs(Date.now() - sentAt) <= REQUEST_TTL_MS;
  }

  /** Whether a message is its owner's own, in their direct chat, whenever it was sent. */
  private ownersOwn(message: OpenedMessage) {
    const client = this.client!;
    return message.security === 'encrypted' && message.senderId === client.owner && client.conversations.get(message.conversationId)?.type === 'direct';
  }

  /** Forgets a folder on its owner's word in the pane: its mark goes, never its files (R-038, D-101). */
  private async forget(message: OpenedMessage) {
    const { forget } = message.content!;
    const folder = forget && this.folderOf(forget.repo);
    if (!folder || !this.fromOwner(message, forget.sentAt)) return;
    await fs.rm(markOf(this.options.dataDir, folder.repo), { force: true });
    await this.scan();
  }

  /** Whether a project that holds both the owner and this agent links the repository, in lower case (D-050, D-108). */
  private async linked(repo: string) {
    const client = this.client!;
    const views = await Promise.all(client.projects.filter((p) => p.memberIds.includes(client.owner!)).map((p) => client.request<ProjectReposDTO>('GET', `/projects/${p.id}/repos`)));
    return views.some((view) => view.repos.some((r) => r.repo.toLowerCase() === repo));
  }

  /** The owner's go for another round on a draft: after a review waits, or with their own words (D-105). */
  private async go(message: OpenedMessage, fix: RunFix) {
    // Only the owner's, once, as for a request (D-089, K-47). Every repository's session hears it,
    // so only the one watching the draft acts or answers.
    if (message.security !== 'encrypted' || message.senderId !== this.client!.owner || !this.client!.remember(message.clientId ?? '', fix.sentAt)) return;
    const plan = this.plans.find((p) => p.taken.message === fix.request);
    const pull = this.watched.find((w) => w.taken.message === fix.request);
    const taken = (plan ?? pull)?.taken;
    if (!taken) return;
    // A signed time, so an old go is not played again (K-42).
    if (Math.abs(Date.now() - fix.sentAt) > REQUEST_TTL_MS) {
      const text = 'I got this more than 10 minutes after you sent it. Ask again.';
      return void (await this.runs!.report(taken, { kind: 'failed', note: text }, text));
    }
    if (plan) {
      // The plan waits no longer: the claim, the draft and the work follow, with the owner's words (docs/decisions/redirect-plan-gate.md).
      this.plans = this.plans.filter((p) => p !== plan);
      await this.savePlans();
      const note = fix.note?.trim() ?? '';
      return void (await this.runs!.follow(plan.taken, plan.request, note ? 'you changed the plan' : 'you said go', { branch: plan.branch }, (signal) => this.claim(plan, (pull) => planBrief(pull, note), signal)));
    }
    if (!pull) return;
    pull.go = { review: fix.review, note: fix.note ?? '' };
    // A run that waits for a decision waits no longer (R-042).
    if (pull.unfinished) delete pull.unfinished.paused;
    await this.saveWatched();
    await this.pollPulls();
  }

  /**
   * A run, as Runs hands it over, in the steps of the repository's own workflow (R-042, D-118). In a
   * worktree of the repository's folder, the background Claude first checks that the card still
   * holds (D-107); a card that no longer does ends the run as stale, with nothing pushed. Otherwise
   * the check's plan waits for its owner's go, unless they turned the gate off, and then an empty
   * commit and the draft claim it before any code (D-062), and the work goes on in the same session.
   */
  private async run({ request, taken, card, cards, decisions, signal }: Parameters<Runner>[0]): Promise<RunResult> {
    const text = noCopy(request.repo!);
    const harness = await this.harnessFor(request.harness);
    const folder = await this.folderFor(request.repo!, signal, () => this.runs!.report(taken, { kind: 'nocopy', note: text }, text));
    const base = await this.fetchBase(folder);
    // A card run again gets a branch of its own, next to the one its earlier run left, here or on origin.
    const { branch, worktree } = await this.bench.prepare({ dir: folder.dir, slug: slugOf(`${request.card}-${request.title}`), taken: await this.keep.branches(folder.repo), tip: base.tip });
    const place: Place = { branch, worktree, base: base.ref, tip: base.tip };
    const session = randomUUID();
    const check = (await this.ask(worktree, session, false, checkBrief(request.card, place, card, decisions, cards), CHECK, signal, harness, { taken, asks: request.asks })) as Record<string, unknown>;
    const date = new Date().toISOString().slice(0, 10);
    if (check.outcome === 'stale') {
      this.endSession(session);
      // The owner's page offers the card's new status, with the reason, as a change they add (D-104).
      const now = readCard(card)!;
      const why = line(check.note, 500).replace(/\.$/, '') || 'It no longer holds';
      const status = `${check.status === 'Done' ? 'Done' : 'Dropped'} on ${date}: ${why}`.slice(0, LIMITS.checkedLength);
      const replaces = { card: now.id, doc: request.docId, section: request.section, seen: await textHash(card.trim()) };
      return { kind: 'stale', branch, note: why, card: { kind: now.kind, title: now.title, body: now.body, status, checked: line(check.checked, 500), replaces } };
    }
    // The files it expects to change, on a line of its own as `scripts/claim.sh -t` writes it, which the overlap rule reads (docs/roadmap/new-overlap-gate.md).
    const touches = (Array.isArray(check.touches) ? check.touches : []).filter((t): t is string => typeof t === 'string' && /^[^\s,`]{1,200}$/.test(t)).slice(0, 100);
    const body = `Claims ${request.card}. Checked ${date}: ${line(check.checked, 500)}${touches.length ? `\n\nTouches: ${touches.join(', ')}` : ''}`;
    const held: Planned = { ...place, taken, request, session, harness: harness.name, repo: folder.repo, body, at: Date.now() };
    // The plan gate, on unless the owner turned off the knob its harness declares (docs/decisions/redirect-plan-gate.md).
    if (!(this.setup.choice.noPlan && harness.offers.knobs.includes('noPlan'))) {
      this.plans.push(held);
      await this.savePlans();
      const plan = typeof check.plan === 'string' ? check.plan.trim().slice(0, LIMITS.runNoteLength) : '';
      return { kind: 'planned', branch, note: plan || undefined };
    }
    return this.claim(held, workBrief, signal);
  }

  /** An empty commit and the draft claim the card before any code (D-062), then the work goes on in the check's session. */
  private async claim({ taken, request, session, harness, repo, body, at, ...place }: Planned, brief: (pull: { repo: string; number: number }) => string, signal: AbortSignal) {
    await this.bench.commit({ worktree: place.worktree, message: `chore: Claim ${request.card}`, allowEmpty: true });
    // A plan kept from before the bundles has no tip: the default branch as it is now stands in.
    const tip = place.tip ?? (await this.keep.fetch(repo)).tip;
    // The tag first: the check above cannot see a claim made seconds ago, but the remote refuses a second tag.
    const card = cardKey(request.card);
    await this.keep.claim(repo, card, place.branch, tip);
    let head: string;
    let pull: { repo: string; number: number };
    try {
      head = (await this.publish(repo, place, tip))!;
      pull = await this.openDraft(place.branch, place.base, `${request.card}: ${request.title}`, body, repo);
    } catch (error) {
      await this.keep.release(repo, card).catch(log);
      throw error;
    }
    // By name, so every round resumes with the harness that started the session.
    const watched: Watched = { ...place, taken, request, pull, head, session, harness, fixes: 0, seenHead: '', seenNote: new Date().toISOString(), unfinished: {} };
    this.watched.push(watched);
    await this.saveWatched();
    // Compared once the draft is published, so of two drafts published seconds apart, the later one waits.
    const holder = await this.heldBy(watched);
    if (holder) return this.wait(watched, holder, { start: brief(pull) });
    return this.finish(watched, brief(pull), true, signal);
  }

  /**
   * A turn of work on a claimed card, in its session: done, with a title and body that replace the
   * claim's, or stopped for a decision nobody foresaw, which waits for its owner's go (R-042). What
   * it commits is pushed, never forced. Its drafts are what it asks of the board. A stop before the
   * work is done pauses it instead (docs/decisions/stop-pauses-run.md).
   */
  private async finish(pull: Watched, brief: string, resume: boolean, signal: AbortSignal): Promise<RunResult> {
    let answer: Answer;
    try {
      answer = await this.work(pull, pull.session!, resume, brief, signal, await this.harnessFor(pull.harness));
    } catch (error) {
      if (!signal.aborted || !pull.unfinished) throw error;
      return this.pause(pull);
    }
    // The board is read only for an answer that names cards or decisions.
    const named = [answer.drafts, answer.decisions].some((list) => Array.isArray(list) && list.length);
    const { seen } = await seenOf(named ? await this.board(this.projectOf(pull.request)) : undefined);
    // A few drafts at most, since each is a message of its own.
    const drafts = draftsOf(answer.drafts, seen, new Set(Object.keys(seen))).slice(0, 5);
    await this.leftovers(pull, answer.title);
    // Only what this turn added: the claim, or the last round, is pushed already.
    if (answer.outcome === 'decision') {
      const decision = drafts.find((d) => d.kind === 'D');
      if (!decision) throw new Error(answer.note || 'I stopped for a decision, but drafted none.');
      pull.head = (await this.publish(pull.pull.repo, pull, pull.head, false)) ?? pull.head;
      pull.unfinished = { paused: Date.now() };
      await this.saveWatched();
      return { kind: 'decision', branch: pull.branch, pull: pull.pull, note: answer.note || undefined, card: decision };
    }
    // Before each push, the files the branch really changes, against what earlier drafts hold (docs/roadmap/new-overlap-gate.md).
    const head = (await this.accept(pull.pull.repo, pull, pull.head))!;
    const files = await this.keep.changed(pull.pull.repo, pull.base, head);
    const holder = await this.heldBy(pull, files);
    if (holder) return this.wait(pull, holder, { files });
    await this.keep.push(pull.pull.repo, pull.branch);
    pull.head = head;
    delete pull.unfinished;
    const made = (Array.isArray(answer.decisions) ? answer.decisions : []).filter((d): d is string => typeof d === 'string' && d.startsWith('D-') && d in seen);
    if (made.length) pull.decisions = [...new Set([...(pull.decisions ?? []), ...made])];
    await this.saveWatched();
    const title = answer.title?.trim();
    // A stacked draft keeps naming the draft under it, which the overlap rule and CI read.
    const body = answer.body?.trim() && `${answer.body.trim()}${pull.stacked ? `\n\n${stackedLine(pull.stacked)}` : ''}`;
    if (title || body) await gh(['pr', 'edit', String(pull.pull.number), '--repo', pull.pull.repo, ...(title ? ['--title', title] : []), ...(body ? ['--body', body] : [])]);
    return { branch: pull.branch, pull: pull.pull, note: answer.note || undefined, drafts };
  }

  /**
   * Keeps a run its owner stopped before its work was done: what is committed is pushed, and the
   * worktree, branch, draft and session wait for their next words, or for a second stop, which
   * closes the draft (docs/decisions/stop-pauses-run.md). The process is dead already.
   */
  private async pause(pull: Watched): Promise<RunResult> {
    await this.leftovers(pull);
    pull.head = (await this.publish(pull.pull.repo, pull, pull.head, false)) ?? pull.head;
    pull.unfinished = { paused: Date.now(), stopped: true };
    await this.saveWatched();
    // The stop is answered; the next one ends the run.
    this.runs!.cancelled.delete(pull.taken.message);
    return { kind: 'paused', branch: pull.branch, pull: pull.pull };
  }

  /**
   * The progress reports of a run: what its turn does now, at most every 30 seconds and only when
   * it changed, as a sealed message in the owner's direct chat (docs/decisions/stop-pauses-run.md).
   * `end` drops a line still waiting, so none comes after the turn's own report.
   */
  private progress(taken: TakenRequest) {
    let sent = '';
    let at = 0;
    let timer: NodeJS.Timeout | undefined;
    const say = (text: string) => {
      if (text === sent) return;
      sent = text;
      at = Date.now();
      this.runs!.report(taken, { kind: 'progress', note: text }, text).catch(log);
    };
    return {
      line: (text: string) => {
        clearTimeout(timer);
        const wait = at + PROGRESS_MS - Date.now();
        if (wait <= 0) say(text);
        else timer = setTimeout(() => say(text), wait);
      },
      end: () => clearTimeout(timer),
    };
  }

  /**
   * Sends a conversation's steps to its owner as sealed `events` messages, which the server never
   * pushes: what came in the last `EVENTS_MS` at once, cut to fit a message, and the rest when the
   * turn ends (R-072). What the session runs with goes along whenever it changed. A server from
   * before them refuses the kind, and the steps are dropped.
   */
  private steps(chat: number, to: string, about: SessionAboutDTO) {
    let queue: SessionEventDTO[] = [];
    let timer: NodeJS.Timeout | undefined;
    let sent = Promise.resolve();
    let told = '';
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const now = JSON.stringify(about);
      // What it runs with goes with the first message, when it changed.
      let extra = now === told ? undefined : about;
      told = now;
      const sizes = queue.map((e) => JSON.stringify(e).length);
      let at = 0;
      while (at < queue.length || extra) {
        // At least one step, each of which fits on its own.
        let [end, size] = [at, 0];
        while (end < queue.length && end - at < LIMITS.eventsPerMessage && (end === at || size + sizes[end]! <= LIMITS.eventsJsonLength)) size += sizes[end++]!;
        const events = queue.slice(at, end);
        at = end;
        const text = events.length === 0 ? 'What the session runs with' : events.length === 1 ? 'One step of the session' : `${events.length} steps of the session`;
        const prompt = { kind: 'events' as const, to, events, ...(extra && { about: extra }) };
        extra = undefined;
        sent = sent.then(() => this.client!.send(chat, { text, prompt }, { kind: 'events' }).then(() => undefined, log));
      }
      queue = [];
      return sent;
    };
    return {
      add: (event: SessionEventDTO) => {
        queue.push(event);
        timer ??= setTimeout(flush, EVENTS_MS);
      },
      about: (more: SessionAboutDTO) => {
        about = { ...about, ...more };
        timer ??= setTimeout(flush, EVENTS_MS);
      },
      end: flush,
    };
  }

  /** Closes the draft of a run that fails before its work is done, saying why, and stops watching it; the branch stays (R-042). */
  private async abandon(taken: TakenRequest, why: string) {
    const pull = this.watched.find((w) => w.unfinished && w.taken.message === taken.message);
    if (!pull) return;
    await this.unwatch(pull);
    await gh(['pr', 'close', String(pull.pull.number), '--repo', pull.pull.repo, '--comment', `The agent stopped: ${why.replace(/\.?$/, '.')} The branch stays.`]).catch(log);
  }

  /** The project of the board that a run's card is on. */
  private projectOf(request: RunRequest) {
    const doc = this.client!.docs.find((d) => d.id === request.docId);
    return (doc && this.client!.conversations.get(doc.conversationId)?.projectId) ?? undefined;
  }

  /** One turn of `harness` in `cwd`: the message on stdin, the JSON answer `schema` asks for (D-097). A card's turn reports its progress to `taken`. */
  private async ask(cwd: string, session: string, resume: boolean, message: string, schema: object, signal: AbortSignal, harness: HarnessInfo, who: Who) {
    const taken = 'taken' in who ? who.taken : undefined;
    const progress = taken && this.progress(taken);
    // A page from before questions sets no flag, and gets no question: its harness refuses what it would ask (docs/decisions/harness-approvals.md).
    const permit = who.asks
      ? () =>
          this.permits!.forTurn({
            session,
            // The owner's direct chat, which is where a card's request is too.
            chat: this.ownerChat() ?? ('taken' in who ? who.taken.conversation : who.chat),
            thread: 'taken' in who ? { request: who.taken.message } : { to: who.to },
          })
      : undefined;
    // One process takes every turn of a session, so it gets every schema the session's turns use.
    const schemas = schema === CHECK || schema === ANSWER ? [CHECK, ANSWER] : [schema];
    // A conversation's own setup and controls: a model, and a permission mode only in own setup (D-157, R-072).
    const talk = 'taken' in who ? undefined : who;
    const own = !!talk?.own;
    const { model, mode } = talk ?? {};
    // Only a page that shows the steps asks for them; an older one would show each batch as a message (R-072).
    const steps = talk?.events ? this.steps(talk.chat, talk.to, { own, ...(talk.branch && { branch: talk.branch }) }) : undefined;
    const { answer, applied } = await this.bench.turn({ harness: harness.name, cwd, session, resume, message, schema, schemas, setup: this.setup.choice, ...(own && { own }), ...(model && { model }), ...(own && mode && { mode }) }, { signal, progress: progress?.line, events: steps?.add, about: steps?.about, permit }).finally(async () => {
      // Before the answer, so the timeline is whole when it ends.
      await steps?.end();
      progress?.end();
      // A conversation's run is its turn.
      if (!taken) this.permits!.drop(session);
    });
    // What the pane learns this turn loaded of the owner's setup.
    this.setup.applied = { ...applied, at: Date.now() };
    await this.keepSetup();
    // The owner may cancel while the turn ends; nothing is pushed or posted then.
    if (signal.aborted) throw new Error('the owner cancelled the run.');
    return answer;
  }

  /** A turn on a card: done or paused with a note, or failed with what blocks it. */
  private async work(pull: Watched, session: string, resume: boolean, message: string, signal: AbortSignal, harness: HarnessInfo) {
    const answer = (await this.ask(pull.worktree, session, resume, message, ANSWER, signal, harness, { taken: pull.taken, asks: pull.request.asks })) as Answer;
    const note = answer.note.trim().slice(0, 500);
    if (answer.outcome !== 'done' && answer.outcome !== 'decision') throw new Error(note || 'I gave up.');
    return { ...answer, note };
  }

  /**
   * A conversation's turn: its scratch copy, then the background Claude there (D-102). The copy is
   * a repository of its own, in the temp folder under a random name: it shares no refs or objects
   * with the checkout, so a turn can move none of the owner's branches, and nothing there is pushed.
   */
  private async converse({ conversation, input, resume, signal, card }: Parameters<Answerer>[0]) {
    const refused = await this.refusal();
    if (refused) throw new Error(refused);
    // The harness the prompt named, or the host: kept by name, so each reply resumes with it.
    const harness = await this.harnessFor(conversation.harness);
    conversation.harness = harness.name;
    // Only a prompt its owner typed, and only while their signed setup turns it on for this harness (D-157).
    const own = !!conversation.own && !!this.setup.choice.own?.includes(harness.name) && harness.offers.knobs.includes('own');
    // A terminal's session goes on only where it started: in their own setup, in their folder (R-072).
    if (conversation.resumed && !(own && conversation.repo)) throw new Error(`I go on with a session from your terminal only in your own setup for ${harness.name}. Turn it on in my settings under Coding agents.`);
    // A session cannot move between a scratch copy and the owner's folder, nor between setups.
    if (resume && own !== !!conversation.ownSetup) throw new Error(`You turned your own setup ${own ? 'on' : 'off'} for ${harness.name} since this conversation started. Start a new one.`);
    conversation.ownSetup = own;
    // A project that links no repository asks about its board alone, in an empty folder (R-038).
    const { repo } = conversation;
    const folder = repo ? await this.folderFor(repo, signal, () => this.client!.send(conversation.chat, { text: noCopy(repo), prompt: { kind: 'nocopy', to: conversation.root } })) : undefined;
    // Sessions outside WebChat claim with draft pull requests, which the sandboxed shell cannot list (R-041).
    const listing = folder && openPulls(folder.repo);
    const board = await this.board(conversation.project);
    // A prompt with neither a project nor a repository runs in an empty folder, with no board.
    if (!folder && conversation.project !== undefined && !board) throw new Error('I am not in that project, so I cannot read its board. Add me to it, then ask again.');
    // Every turn fetches, so a reply after a merge reads the merged code, not the first turn's. In
    // their own setup the turn works in their folder as it stands, which nothing here moves.
    const base = folder && !own ? await this.fetchBase(folder).catch(() => {
      throw new Error('The laptop could not get your team’s code from GitHub. Check that it is online, then ask again.');
    }) : undefined;
    // In their own setup the turn works in their folder, so it makes no copy: one without git would
    // be kept for a later restricted turn, such as after a hand over (D-156).
    const { scratch, fetched } =
      own && folder
        ? { scratch: conversation.scratch, fetched: conversation.fetched }
        : await this.bench.scratch({ scratch: conversation.scratch, dir: own ? undefined : folder?.dir, base: base?.ref, tip: base?.tip, fetched: conversation.fetched });
    // A new copy starts at the tip, so nothing moved under it.
    const was = scratch === conversation.scratch ? conversation.fetched : undefined;
    conversation.scratch = scratch;
    conversation.fetched = fetched;
    let moved = '';
    if (base && was && fetched !== was) {
      const [a, b, branch] = [was.slice(0, 7), fetched!.slice(0, 7), base.ref.replace(/^origin\//, '')];
      moved = `Since your last turn, ${branch} moved from ${a} to ${b}. Your scratch copy now holds ${b}, and anything you changed in it is gone. \`git diff ${a} ${b}\` shows what changed: reread what your answer relies on.`;
    }
    const pulls = await listing;
    const { items, seen } = await seenOf(board);
    // A reply shows what changed since the agent last saw it, so a draft starts from what the board says now.
    const changed = items.filter((c) => conversation.seen?.[c.id]?.hash !== seen[c.id]!.hash).map((c) => c.text);
    const listed = folder ? pullList(pulls) : '';
    const message = resume
      ? [
          ...(moved ? [moved, ''] : []),
          `Your owner replies:\n\n${input}`,
          ...(changed.length ? ['', fence('Cards and decisions that changed on the board since', changed)] : []),
          ...(listed !== (conversation.pulls ?? '') ? ['', listed] : []),
        ].join('\n')
      : promptBrief(input, board, folder?.repo, listed, own);
    // The new card form asks for one draft, from its fields as they stand, which the owner may have edited (R-071).
    const asked = card ? `${message}\n\n${cardAsk(card)}` : message;
    // Never the owner's folder as `scratch`, which an ended conversation removes.
    const cwd = own && folder ? folder.dir : scratch!;
    const answer = (await this.ask(cwd, conversation.session, resume, asked, REPLY, signal, harness, { chat: conversation.chat, to: conversation.root, asks: conversation.asks, own, events: conversation.events, ...(base && { branch: base.ref.replace(/^origin\//, '') }), model: conversation.model, mode: conversation.mode })) as { reply?: unknown; drafts?: unknown };
    // Only once the turn read them, so a turn cut short tells the next one again.
    conversation.seen = seen;
    conversation.pulls = listed;
    const held = new Set([...Object.keys(seen), ...(pulls ?? []).map((p) => `#${p.number}`)]);
    const drafts = draftsOf(answer.drafts, seen, held);
    return { reply: String(answer.reply ?? ''), drafts: card ? drafts.filter((d) => !d.replaces && d.kind === card.kind).slice(0, 1) : drafts.slice(0, 2) };
  }

  /**
   * The board of the one project its owner's page picked for the prompt, for drafts grounded in it
   * (D-104): its roadmap cards and the decisions the team holds, each with its place. Never every project: anyone
   * can add the agent to theirs, and their cards would then speak in the owner's brief. A column that
   * does not open is left out, not a failed turn.
   */
  private async board(projectId: number | undefined) {
    const client = this.client!;
    const project = client.projects.find((p) => p.id === projectId && p.memberIds.includes(client.owner!));
    if (!project) return undefined;
    const docs: { roadmap?: DocDTO; decisions?: DocDTO } = await client.boardDocs(project.id).catch(() => ({}));
    const [cards, decisions] = await Promise.all([this.cardsOf(docs.roadmap), this.cardsOf(docs.decisions)]);
    return { project: project.name, cards, decisions: decisions.filter((d) => isHeld(d.text)) };
  }

  /**
   * Pushes what a run committed after `since`, never forced: the worktree makes a bundle of its
   * branch alone, the agent's own clone takes it only if it passes its checks, and that pushes.
   * Returns the commit pushed, or undefined for no new commits when `required` is false.
   */
  private async publish(repo: string, place: Place, since: string, required = true) {
    const head = await this.accept(repo, place, since, required);
    if (head) await this.keep.push(repo, place.branch);
    return head;
  }

  /** Takes what the worktree committed since `since` into the agent's clone, unpushed, and returns the branch's new head. */
  private async accept(repo: string, place: Place, since: string, required = true) {
    const head = await this.bundled(async (file) => {
      const made = await this.bench.bundle({ worktree: place.worktree, branch: place.branch, since, file });
      return made && this.keep.acceptBundle(repo, file, { branch: place.branch, since, reported: made });
    });
    if (!head && required) throw new Error('I left no new commits.');
    return head || undefined;
  }

  /** Commits what a harness that cannot commit left in its worktree, titled with the work's own title. */
  private async leftovers(pull: Place & { harness?: string; request: RunRequest }, title?: string) {
    if (this.harnesses.find((h) => h.name === pull.harness)?.commits === false) await this.bench.commit({ worktree: pull.worktree, message: title?.trim() || `chore: Work on ${pull.request.card}`, leftovers: true });
  }

  /** Runs `work` with the path of a bundle in the agent's own folder, which goes afterwards. */
  private async bundled<T>(work: (file: string) => Promise<T>) {
    const dir = path.join(this.options.dataDir, 'bundles');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${randomUUID()}.bundle`);
    try {
      return await work(file);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  /**
   * Fetches a repository into the agent's clone, and sends what is new of its default branch into
   * the folder as a bundle, whole when the folder lacks what the last one built on. A worktree or a
   * scratch copy starts from it.
   */
  private async fetchBase(folder: Folder) {
    const base = await this.keep.fetch(folder.repo);
    const since = this.sent.get(folder.dir);
    if (since !== base.tip) {
      const take = (from?: string) =>
        this.bundled(async (file) => {
          await this.keep.baseBundle(folder.repo, file, base.ref, from);
          await this.bench.take(folder.dir, file, base.ref);
        });
      await take(since).catch((error: unknown) => (since && error instanceof PrerequisitesMissing ? take() : Promise.reject(error)));
      this.sent.set(folder.dir, base.tip);
    }
    return base;
  }

  /** Opens the run's draft pull request, with the title and body the answer gave. */
  private async openDraft(branch: string, base: string, title: string, body: string, repo: string) {
    const opened = await gh(['pr', 'create', '--draft', '--repo', repo, '--base', base.replace(/^origin\//, ''), '--head', branch, '--title', title, '--body', body]);
    const number = Number(/\/pull\/(\d+)/.exec(opened)?.[1]);
    if (!number) throw new Error(`gh opened no pull request: ${opened}`);
    return { repo, number };
  }

  /** Writes the mark that names a repository's folder, and reads the marks again when this process serves. */
  private async mark(repo: string, dir: string) {
    const mark = markOf(this.options.dataDir, repo);
    await fs.mkdir(path.dirname(mark), { recursive: true, mode: 0o700 });
    await fs.writeFile(mark, dir);
    if (this.client) await this.scan();
  }

  /** What `webchat-agent sleep` says, once the agent is told to go to sleep. */
  async goToSleep() {
    const busy = await this.sleep();
    return `Your agent goes to sleep ${busy.length ? `once it finishes ${busy.join(' and ')}` : 'within 15 seconds, once nothing runs'}. To wake it, ${WAKE}.`;
  }

  /** What the agent says of itself, for `webchat-agent status` and for `doctor` and setup, which read the fields (docs/decisions/locked-room.md). */
  async status(): Promise<AgentStatus> {
    const asleep = existsSync(this.asleep);
    // A waiting loop looks at the switch only once a minute, so the status reads it now.
    if (this.problem || !this.client) return { text: asleep ? this.asleepWords : this.problem, paired: !!this.client, asleep };
    const owner = this.client.users.get(this.client.owner!)?.displayName;
    const sandbox = await this.cardRefusal();
    const folders = [...this.folders.values()].map((f) => `${f.repo} in ${shown(f.dir)}`);
    const linked = this.linkedHarnesses().map((h) => h.name);
    const signed = await signedIn();
    const github = signed ? (this.login ??= await gh(['api', 'user', '--jq', '.login']).catch(() => undefined)) : undefined;
    const text = [
      sandbox ? `Every card fails at once: ${sandbox}` : `Taking the cards that ${owner ?? 'your owner'} hands to this agent, on ${this.client.api.baseUrl}.`,
      folders.length ? `Working in ${folders.join(', ')}.` : 'No folders yet: your agent offers to clone a repository when you ask it about one.',
      ...(this.runs!.running.length ? [`Working on ${this.runs!.running.map((r) => r.card).join(', ')}.`] : []),
      `Watching ${this.watched.length} draft pull requests.`,
      `Linked: ${linked.join(', ') || 'none'}.`,
      signed ? `GitHub: the agent is signed in${github ? ` as ${github}` : ''}.` : 'GitHub: the agent is not signed in.',
    ].join('\n');
    return { text, paired: true, server: this.client.api.baseUrl, signedIn: signed, ...(github && { github }), asleep, ...(sandbox && { refusal: sandbox }), linked, folders };
  }

  /**
   * Stops watching each draft whose request is not in the owner's direct chat with this agent, as
   * every draft from before D-105 is. The pane builds a card's thread only from that chat, so it
   * would show neither a review that waits for the owner's go nor the button that sends it (K-58).
   */
  async endStrandedDrafts() {
    for (const pull of [...this.watched]) {
      // A chat this session does not know is left alone: its first check-in may have failed.
      const chat = this.client!.conversations.get(pull.taken.conversation);
      if (chat && chat.type !== 'direct') await this.end(pull, 'its request is not in your direct chat with me, so the pane cannot show you its reviews');
    }
  }

  /**
   * Looks at each pull request this server opened. When CI failed on its last push, it conflicts, or
   * its owner reviewed it, the model gets another round, at most three. A review by someone else who
   * may push waits for the owner's go, and the owner's own rounds count toward no limit (D-105).
   * Watching stops when someone else pushes, it is closed or merged, or the owner cancels its run.
   * A plan that waits for its owner's go ends on a stop, or after 7 days.
   */
  async pollPulls(now = Date.now()) {
    // A question nobody answered in 7 days fails its turn, whatever else holds the poll back.
    await this.permits?.expire(now);
    if (this.polling || !this.runs || (await this.refusal())) return;
    this.polling = true;
    try {
      for (const plan of [...this.plans]) {
        const why = this.runs.cancelled.has(plan.taken.message) ? 'You stopped it.' : now - plan.at > 7 * DAY_MS ? 'No go came within 7 days.' : '';
        if (!why) continue;
        this.plans = this.plans.filter((p) => p !== plan);
        this.endSession(plan.session);
        await this.savePlans();
        await this.runs.fail(plan.taken, why);
      }
      for (const pull of [...this.watched]) {
        // A round waits while its card runs, and the cards beside it go on (R-037).
        if (this.runs.running.some((r) => r.docId === pull.request.docId && r.section === pull.request.section)) continue;
        // A draft whose folder is gone, or unsafe now, or whose harness starts nothing now, waits until it is back.
        const folder = this.folderOf(pull.pull.repo);
        if (!folder) continue;
        const { harness, refused } = await this.pick(pull.harness);
        if (!harness || refused || this.folderRefusal(folder)) continue;
        // A run that waits for a decision needs only whether its draft ended.
        const fields = pull.unfinished?.paused || pull.unfinished?.overlap ? 'state,headRefOid' : PULL_FIELDS;
        const view = JSON.parse(await gh(['pr', 'view', String(pull.pull.number), '--repo', pull.pull.repo, '--json', fields])) as PullView;
        const ended = this.endOf(pull, view, now);
        if (ended && pull.unfinished && view.state !== 'MERGED') {
          // A run that ends before its work is done fails, which closes its draft (R-042).
          await this.runs.fail(pull.taken, `${ended[0]!.toUpperCase()}${ended.slice(1)}.`);
          continue;
        }
        if (ended) {
          await this.end(pull, ended, view.state);
          continue;
        }
        if (pull.unfinished?.overlap) {
          await this.overlapLook(pull, pull.unfinished.overlap);
          continue;
        }
        // It goes on only on its owner's go, and reminds them once after a day (R-042).
        if (pull.unfinished?.paused) {
          if (now - pull.unfinished.paused > DAY_MS && !pull.unfinished.reminded) {
            pull.unfinished.reminded = true;
            await this.saveWatched();
            const card = pull.request.card;
            const [kind, note, text] = pull.unfinished.stopped
              ? (['paused', 'I am still stopped.', `I am still stopped on ${card}. Tell me what to change, or start the card over.`] as const)
              : (['decision', 'I still wait for the decision.', `I still wait for your decision on ${card}. Add it on the board, then tell me to go on.`] as const);
            await this.runs.report(pull.taken, { kind, note, pull: pull.pull }, text);
          }
          continue;
        }
        if (pull.go) {
          // Only the review the owner approved, as it showed it, and their words; a reply alone runs only those.
          const asked = pull.go.review === undefined ? undefined : pull.waiting?.find((w) => w.report === pull.go!.review);
          // A stopped run's words go to its brief as they are, fenced (docs/decisions/stop-pauses-run.md).
          const why = pull.unfinished?.stopped
            ? { line: 'you told me what to change', details: pull.go.note }
            : { line: asked?.line ?? (pull.unfinished ? 'you added the decision' : 'you asked for changes'), details: [asked?.details, pull.go.note && `Your owner asks:\n\n${pull.go.note}`].filter(Boolean).join('\n\n') };
          pull.waiting = pull.waiting?.filter((w) => w !== asked);
          delete pull.go;
          await this.saveWatched();
          if (!why.details) continue;
          await this.runs.follow(pull.taken, pull.request, why.line, { branch: pull.branch, pull: pull.pull }, (signal) => this.fix(pull, why, signal));
          continue;
        }
        const why = await this.whatToFix(pull, view);
        if (!why) continue;
        if (pull.fixes >= MAX_FIXES) {
          await this.unwatch(pull);
          await this.runs.fail(pull.taken, `I stopped after ${MAX_FIXES} rounds of fixes: ${why.line}.`);
          continue;
        }
        pull.fixes++;
        await this.saveWatched();
        await this.runs.follow(pull.taken, pull.request, why.line, { branch: pull.branch, pull: pull.pull }, (signal) => this.fix(pull, why, signal));
      }
    } finally {
      this.polling = false;
    }
  }

  /** Why watching a pull request stops, or '' while it goes on. A run that waits for a decision, or for words after a stop, waits 7 days at most (R-042). */
  private endOf(pull: Watched, view: PullView, now: number) {
    const stopped = pull.unfinished?.stopped;
    if (this.runs!.cancelled.has(pull.taken.message)) return stopped ? 'you started it over' : 'you stopped it';
    if (view.state === 'MERGED') return 'it was merged';
    if (view.state !== 'OPEN') return 'it was closed';
    if (view.headRefOid !== pull.head) return 'someone else pushed to it';
    return pull.unfinished?.paused && now - pull.unfinished.paused > 7 * DAY_MS ? `no ${stopped ? 'words' : 'decision'} came within 7 days` : '';
  }

  /** Stops watching a pull request and says why in the chat of its request (D-105). */
  private async end(pull: Watched, why: string, state = '') {
    await this.unwatch(pull);
    const merged = state === 'MERGED';
    // A merge finishes the card, which the owner's page marks Done or Fixed (R-042). A close
    // unmerged gives the card back its old status, or it would say In review for good.
    await this.runs!.report(pull.taken, { kind: merged ? 'merged' : state === 'CLOSED' ? 'closed' : 'ended', note: why, pull: pull.pull, ...(merged && pull.decisions && { decisions: pull.decisions }) }, `I stopped watching ${pull.pull.repo}#${pull.pull.number}: ${why}.`);
  }

  /** What is new to fix: CI that failed on the head, a conflict, or review notes from people who may push. */
  private async whatToFix(pull: Watched, view: PullView) {
    const why: string[] = [];
    const details: string[] = [];
    if (pull.seenHead !== view.headRefOid) {
      const failed = view.statusCheckRollup.filter((c) => FAILED.has(c.conclusion || c.state || ''));
      if (failed.length) {
        why.push(`CI failed: ${failed.map((c) => c.name ?? c.context).join(', ')}`);
        details.push(await this.ciLog(pull.pull.repo, failed));
      }
      if (view.mergeable === 'CONFLICTING') {
        why.push(`it conflicts with ${pull.base}`);
        details.push(`The branch conflicts with ${pull.base}, which is fetched. Merge it into the branch and resolve the conflicts.`);
      }
      if (why.length) pull.seenHead = view.headRefOid;
    }
    const notes = await this.reviewNotes(pull, view);
    if (notes.length) pull.seenNote = notes.map((n) => n.at).sort().at(-1)!;
    // A lookup that failed is tried again next time; until then every review waits for the go.
    const login = (this.login ??= await gh(['api', 'user', '--jq', '.login']).catch(() => undefined));
    const list = (from: typeof notes) => from.map((n) => `- ${n.author}: ${n.text}`).join('\n');
    const own = notes.filter((n) => n.author === login);
    if (own.length) {
      why.push('your review');
      details.push(list(own));
    }
    // Text others wrote runs with the owner's login, so it waits for their go, shown in full (D-105).
    const others = notes.filter((n) => n.author !== login);
    if (others.length) {
      const names = [...new Set(others.map((n) => n.author))].join(', ');
      const text = `${names} asked for changes on ${pull.pull.repo}#${pull.pull.number}:\n\n${list(others)}`.slice(0, LIMITS.messageLength);
      const shown = await this.runs!.report(pull.taken, { kind: 'review', note: `${names} asked for changes`, pull: pull.pull }, text);
      // The go runs this text, as the report showed it, cut where it was cut.
      pull.waiting = [...(pull.waiting ?? []), { report: shown.id, line: `review from ${names}`, details: text }];
      await this.saveWatched();
    }
    return why.length ? { line: why.join('; '), details: details.join('\n\n') } : null;
  }

  /** Review notes since the last round, from people who may push to the repository. None while GitHub saw no change. */
  private async reviewNotes(pull: Watched, view: PullView) {
    if (view.updatedAt === pull.seenUpdate) return [];
    pull.seenUpdate = view.updatedAt;
    const inline = JSON.parse(await gh(['api', `repos/${pull.pull.repo}/pulls/${pull.pull.number}/comments`])) as Array<{
      user: { login: string };
      body: string;
      path: string;
      line: number | null;
      created_at: string;
    }>;
    const all = [
      ...view.reviews.filter((r) => r.body.trim()).map((r) => ({ author: r.author.login, at: r.submittedAt, text: r.body })),
      ...view.comments.map((c) => ({ author: c.author.login, at: c.createdAt, text: c.body })),
      ...inline.map((c) => ({ author: c.user.login, at: c.created_at, text: `on ${c.path}${c.line ? ` line ${c.line}` : ''}: ${c.body}` })),
    ].filter((n) => n.at > pull.seenNote);
    const notes = [];
    for (const note of all) if (await this.mayPush(pull.pull.repo, note.author)) notes.push(note);
    return notes;
  }

  private async mayPush(repo: string, login: string) {
    const key = `${repo} ${login}`;
    if (!this.writers.has(key)) {
      const answer = await gh(['api', `repos/${repo}/collaborators/${login}/permission`]).catch(() => '{}');
      this.writers.set(key, ['admin', 'maintain', 'write'].includes((JSON.parse(answer) as { permission?: string }).permission ?? ''));
    }
    return this.writers.get(key)!;
  }

  /** Which checks failed, and the end of the first failed Actions log, which the sandboxed shell cannot fetch. */
  private async ciLog(repo: string, failed: PullView['statusCheckRollup']) {
    const names = failed.map((c) => `${c.name ?? c.context} (${c.detailsUrl ?? 'no link'})`).join(', ');
    const run = failed.map((c) => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? '')?.[1]).find(Boolean);
    const output = run ? await gh(['run', 'view', run, '--repo', repo, '--log-failed']).catch(() => '') : '';
    const tail = output.split('\n').slice(-150).join('\n');
    return `Checks that failed: ${names}.${tail ? `\n\nThe end of the failed log:\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`;
  }

  /** A round of fixes: fetches here, since the shell reaches no GitHub, then resumes the run's Claude session. */
  private async fix(pull: Watched, why: { line: string; details: string }, signal: AbortSignal): Promise<RunResult> {
    const folder = this.folderOf(pull.pull.repo);
    if (!folder) throw new Error(noCopy(pull.pull.repo));
    await this.fetchBase(folder);
    // With hooks off: the branch the worktree checks out is the model's.
    await this.bench.reopen({ dir: folder.dir, worktree: pull.worktree, branch: pull.branch });
    // A draft from before R-035 has no session to resume, so its first round starts one.
    const resume = pull.session !== undefined;
    pull.session ??= randomUUID();
    return this.finish(pull, (pull.unfinished?.stopped ? steerBrief : pull.unfinished ? goBrief : fixBrief)(pull, why), resume, signal);
  }

  /**
   * The earliest open draft that holds a file this run's draft needs: by its `Touches:` line before
   * any work, or by `files`, what its branch changes, before a push. The rule of the `overlap` check,
   * where the lower number keeps a file; none when GitHub does not answer, so a repository with no
   * GitHub link has no gate (docs/roadmap/new-overlap-gate.md).
   */
  private async heldBy(pull: Watched, files?: string[]) {
    const open = (await openPulls(pull.pull.repo, 'number,title,headRefName,body,files')) as Array<Pull & Footprint> | undefined;
    const mine = open?.find((p) => p.number === pull.pull.number);
    const [first] = mine ? overlaps(files ? { ...mine, files: files.map((path) => ({ path })) } : mine, open!) : [];
    const other = first && open!.find((p) => p.number === first.number)!;
    return other && { number: other.number, waits: cardOfPull(other) ?? `#${other.number}`, branch: other.headRefName, files: first.files };
  }

  /** Holds a run whose files an earlier draft holds: it does no more until that draft lets them go or the two card owners choose. */
  private async wait(pull: Watched, holder: NonNullable<Awaited<ReturnType<Plugin['heldBy']>>>, { start, files }: Pick<Overlap, 'start' | 'files'>): Promise<RunResult> {
    const words = (await this.overlapCards(pull, holder.waits))?.card.words ?? [];
    pull.unfinished = { overlap: { number: holder.number, waits: holder.waits, branch: holder.branch, since: Math.max(0, ...words.map((w) => w.id)), start, files } };
    await this.saveWatched();
    return { kind: 'overlap', branch: pull.branch, pull: pull.pull, waits: holder.waits, note: holder.files.join(', ') };
  }

  /** The waiting card with each member's word on it, and who chooses for it: its owner and the owner of the card it waits for. */
  private async overlapCards(pull: Watched, waits: string) {
    const found = await this.boardCard(pull.request);
    return found && { card: found.card, owners: choosers(found.card.owner, found.cards.find((c) => cardKey(c.cardId) === waits)?.owner, this.client!.owner!) };
  }

  /** A request's card as every page reads it, with the other cards of its board, or none when the board or the card is gone. */
  private async boardCard(request: RunRequest) {
    const client = this.client!;
    const doc = client.docs.find((d) => d.id === request.docId);
    const project = client.projects.find((p) => p.id === this.projectOf(request));
    if (!doc || !project) return;
    const cards = this.roadmapCards(project, await client.cardSections(doc));
    const card = cards.find((c) => c.id === request.section);
    return card && { card, cards };
  }

  /**
   * Looks again at a run that waits for an earlier draft. A fold its card owners chose ends it; a
   * stack names that draft in its body, so neither this rule nor CI counts it, and the run goes on
   * on its branch; and the run goes on once no earlier draft holds its files. Only a line an owner
   * signed counts, and the agent never chooses (docs/roadmap/new-overlap-gate.md, D-081).
   */
  private async overlapLook(pull: Watched, wait: Overlap) {
    const found = await this.overlapCards(pull, wait.waits);
    const choice = found && choiceOf(found.card.words ?? [], found.owners, wait.waits, wait.since);
    if (choice === 'fold') return this.runs!.fail(pull.taken, `Its owners folded ${pull.request.card} into ${wait.waits}.`);
    const where = ['--repo', pull.pull.repo];
    if (choice === 'stack' && pull.stacked !== wait.number) {
      const body = await gh(['pr', 'view', String(pull.pull.number), ...where, '--json', 'body', '--jq', '.body']);
      await gh(['pr', 'edit', String(pull.pull.number), ...where, '--body', `${body}\n\n${stackedLine(wait.number)}`]);
      pull.stacked = wait.number;
      await this.saveWatched();
    }
    const holder = await this.heldBy(pull, wait.files);
    // Another earlier draft holds its files now, and its owners choose for that one.
    if (holder && holder.number !== wait.number) return this.runs!.done(pull.taken, await this.wait(pull, holder, wait));
    if (holder) return;
    const why = pull.stacked === wait.number ? `its owners stacked it on ${wait.waits}` : `${wait.waits} no longer holds its files`;
    await this.runs!.follow(pull.taken, pull.request, why, { branch: pull.branch, pull: pull.pull }, (signal) => this.goOn(pull, wait, signal));
  }

  /** The turn of a run that waited for an earlier draft: on that draft's branch when stacked, with the work's own brief when it had not started. */
  private async goOn(pull: Watched, wait: Overlap, signal: AbortSignal): Promise<RunResult> {
    const folder = this.folderOf(pull.pull.repo);
    if (!folder) throw new Error(noCopy(pull.pull.repo));
    await this.fetchBase(folder);
    const stacked = pull.stacked === wait.number ? wait.branch : undefined;
    if (stacked)
      await this.bundled(async (file) => {
        await this.keep.baseBundle(folder.repo, file, `origin/${stacked}`);
        await this.bench.take(folder.dir, file, `origin/${stacked}`, true);
      });
    await this.bench.reopen({ dir: folder.dir, worktree: pull.worktree, branch: pull.branch });
    pull.unfinished = {};
    await this.saveWatched();
    return this.finish(pull, overlapBrief(pull, wait.waits, stacked, wait.start), true, signal);
  }

  /** Ends what a harness keeps running for a session that is over: its process. */
  private endSession(session?: string) {
    if (session) void this.bench.end(session).catch(log);
  }

  private async unwatch(pull: Watched) {
    this.endSession(pull.session);
    this.watched = this.watched.filter((w) => w !== pull);
    await this.saveWatched();
  }

  private saveWatched() {
    return fs.writeFile(this.file('pulls.json'), JSON.stringify(this.watched, null, 2));
  }

  private savePlans() {
    return fs.writeFile(this.file('plans.json'), JSON.stringify(this.plans, null, 2));
  }
}
