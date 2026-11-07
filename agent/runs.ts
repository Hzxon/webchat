// Runs a board card when the agent's owner asks for it (R-027, D-086, D-089). A request is a sealed
// message, in the owner's direct chat with this account (D-105), whose `run` field names the card,
// with the hash of the brief the owner saw. The agent claims it, hands the card to the runner, which
// is where the coding agent runs, then reports done or failed. Every report is a message of its own
// that names the request, and pages fold them into one card. The owner can cancel a request the
// same way (R-030).
import { textHash } from '../shared/e2ee.ts';
import { briefText, heldDecisions, type CardDraftDTO, type RunReport, type RunRequest } from '../shared/types.ts';
import type { AgentClient, OpenedMessage, TakenRequest } from './client.ts';

export interface RunResult {
  /**
   * How the run ended: done, stale when its check found the card no longer holds and nothing was
   * pushed, or paused for a decision nobody foresaw, which waits for its owner's go (R-042).
   */
  kind?: 'done' | 'stale' | 'decision';
  branch: string;
  pull?: { repo: string; number: number };
  /** A line for the report, such as what the agent said last, or why the card no longer holds. */
  note?: string;
  /** For stale, the change of the card's status that the owner's page offers; for decision, the decision's draft (R-042). */
  card?: CardDraftDTO;
  /** What finished work asks of the board: changes to decisions, and new cards (R-042). */
  drafts?: CardDraftDTO[];
}

/**
 * Does the work of one run, given the card, its board's cards and the decisions it follows as
 * Markdown. Where the coding agent runs. It stops when the signal aborts.
 */
export type Runner = (job: { request: RunRequest; taken: TakenRequest; card: string; cards: string[]; decisions: string; projectId: number; signal: AbortSignal }) => Promise<RunResult>;

/** A request older than this when the daemon first sees it is not run: nobody is waiting for it. */
export const REQUEST_TTL_MS = 10 * 60_000;

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A card is the board's doc and section, since two projects can each have a K-1 (D-099). */
const cardOf = (run: RunRequest) => `${run.docId}/${run.section}`;

export class Runs {
  /** The work in progress, by card: its request, the request's message, and how to stop it (R-037). */
  private readonly current = new Map<string, { run: RunRequest; message: number; stop: AbortController }>();
  /** Requests their owner cancelled, by message id, so nothing more is done for them (R-030). */
  readonly cancelled = new Set<number>();

  constructor(
    private readonly client: AgentClient,
    private readonly runner: Runner,
    /** Why this machine will not run a request, checked before it is claimed. The plugin checks its repository and sandbox. */
    private readonly refuse: (run: RunRequest) => Promise<string | undefined> = async () => undefined,
    /** What else a failure ends: the plugin closes the draft of a run whose work was not done (R-042). */
    private readonly onFail: (taken: TakenRequest, note: string) => Promise<void> = async () => undefined,
  ) {}

  /** The requests being run. */
  get running() {
    return [...this.current.values()].map((c) => c.run);
  }

  /**
   * Reports each run that the daemon was in when it stopped as failed, so its card does not stay
   * claimed with nothing running (K-46). Called once at start, after the first check-in.
   */
  async recover() {
    for (const left of this.client.running) {
      await this.fail(left, 'The daemon stopped during the run.');
      await this.client.saveRunning(this.client.running.filter((t) => t !== left));
    }
  }

  /** Runs a request addressed to this account, or stops one its owner cancels, and reports. Anything else is ignored. */
  async handle(message: OpenedMessage) {
    const run = message.content?.run;
    if (message.security !== 'encrypted' || !run) return;
    if (run.kind === 'cancel') {
      // The id is the server's, so at worst a changed server stops another of the owner's runs.
      if (message.senderId !== this.client.owner) return;
      this.cancelled.add(run.request);
      for (const c of this.current.values()) if (c.message === run.request) c.stop.abort();
      return;
    }
    if (run.kind !== 'request' || run.runtime !== this.client.id) return;
    // A copy the server posted again under a new id: nothing runs, and nothing answers it (K-47).
    if (!this.client.remember(message.clientId ?? '', run.sentAt ?? 0)) return;
    const taken: TakenRequest = { message: message.id, conversation: message.conversationId, card: run.card };
    const failed = (note: string) => this.fail(taken, note);
    // The signature checked the sender against the keys pinned for them, so the id is the owner's.
    if (message.senderId !== this.client.owner) {
      return failed(`Only ${this.client.users.get(this.client.owner!)?.displayName ?? 'my owner'} hands cards to me.`);
    }
    // The time the owner's page signed, not the server's, which could play an old request again (K-42).
    if (!run.sentAt || Math.abs(Date.now() - run.sentAt) > REQUEST_TTL_MS) return failed('I got this more than 10 minutes after you sent it. Open the card again and press Start.');
    // A page from before D-105 signs no brief, so nothing tells the agent what its owner saw.
    if (!run.hash) return failed('Reload WebChat, then open the card again and press Start.');
    // Two tabs or two devices can each send a request before either has seen the other's, and the
    // server cannot tell them apart (D-014). The card runs once; another card runs beside it (R-037).
    if (this.current.has(cardOf(run))) return failed(`${run.card} is already running.`);
    return this.execute(taken, run, async (signal) => {
      const refused = await this.refuse(run);
      if (refused) throw new Error(refused);
      // The card must be on a board of a project this account is in, and its brief the one its owner
      // saw and signed. Whoever wrote them, the owner chose to run them (D-105).
      const doc = this.client.docs.find((d) => d.id === run.docId);
      const projectId = doc && this.client.conversations.get(doc.conversationId)?.projectId;
      const sections = doc ? await this.client.sections(doc) : [];
      const card = sections.find((s) => s.id === run.section);
      if (!projectId || !card) throw new Error('I can’t find that card on the board anymore. Open it again and press Start.');
      const { decisions } = await this.client.boardDocs(projectId);
      const held = decisions ? (await this.client.sections(decisions)).map((s) => s.text) : [];
      if ((await textHash(briefText(card.text, held))) !== run.hash) throw new Error('The card or a decision changed since you opened it. Open the card again and press Start.');
      await this.report(taken, { kind: 'claimed' }, `I am on ${run.card}: ${run.title}`);
      return this.runner({ request: run, taken, card: card.text, cards: sections.map((s) => s.text), decisions: heldDecisions(held).join('\n\n'), projectId, signal });
    });
  }

  /**
   * Another round on a request this account ran: fixing its pull request after CI failed, a
   * conflict or a review (R-030). Reports fixing, then done or failed, as a run does. False when
   * its card runs already, so the caller tries again later.
   */
  async follow(taken: TakenRequest, run: RunRequest, why: string, last: RunResult, work: (signal: AbortSignal) => Promise<RunResult>) {
    if (this.current.has(cardOf(run))) return false;
    await this.execute(taken, run, async (signal) => {
      await this.report(taken, { kind: 'fixing', note: why, branch: last.branch, pull: last.pull }, `I am back on ${run.card}: ${why}`);
      return work(signal);
    });
    return true;
  }

  async fail(taken: TakenRequest, note: string) {
    await this.onFail(taken, note);
    return this.report(taken, { kind: 'failed', note }, `I could not run ${taken.card}: ${note}`);
  }

  /**
   * Does one piece of work and reports how it ended. Taken before the first wait, so a request
   * from the same check-in finds its card running. Kept in the file while it runs (K-46).
   */
  private async execute(taken: TakenRequest, run: RunRequest, work: (signal: AbortSignal) => Promise<RunResult>) {
    const stop = new AbortController();
    const card = cardOf(run);
    this.current.set(card, { run, message: taken.message, stop });
    try {
      await this.client.saveRunning([...this.client.running, taken]);
      await this.done(taken, await work(stop.signal));
    } catch (error) {
      await this.fail(taken, messageOf(error));
    } finally {
      this.current.delete(card);
    }
    // Only once a report got through. Otherwise the next start sends one.
    await this.client.saveRunning(this.client.running.filter((t) => t.message !== taken.message));
  }

  /** Reports how a run ended, then each draft its finished work asks of the board (R-042). */
  private async done(taken: TakenRequest, { kind = 'done', branch, pull, note, card, drafts = [] }: RunResult) {
    const text = {
      done: `I finished ${taken.card} on ${branch}${pull ? ` (${pull.repo}#${pull.number})` : ''}.${note ? ` ${note}` : ''}`,
      stale: `${taken.card} no longer holds: ${note}.`,
      decision: `${taken.card} needs a decision first: ${card?.title}. Add it on the board, then tell me to go on.`,
    }[kind];
    await this.report(taken, { kind, branch, pull, card, ...(note && { note }) }, text);
    for (const draft of drafts) await this.report(taken, { kind: 'draft', card: draft }, `${draft.kind === 'D' ? 'Decision' : 'Card'} draft: ${draft.title}`);
  }

  report(taken: TakenRequest, reply: Omit<RunReport, 'request'>, text: string) {
    return this.client.send(taken.conversation, { text, run: { ...reply, request: taken.message } });
  }
}
