// Runs a board card when the agent's owner asks for it (R-027, D-086, D-089). A request is a sealed
// message in the project's #general whose `run` field names the card and this account. The agent
// claims it, hands the card to the runner, which is where the coding agent runs, then reports done
// or failed. Every report is a message of its own that names the request, and pages fold them
// into one card. The owner can cancel a request the same way (R-030).
import type { RunReport, RunRequest } from '../shared/types.ts';
import type { AgentClient, OpenedMessage, TakenRequest } from './client.ts';

export interface RunResult {
  branch: string;
  pull?: { repo: string; number: number };
  /** A line for the done report, such as what the agent said last. */
  note?: string;
}

/** Does the work of one run, given the card as Markdown. Where the coding agent runs. It stops when the signal aborts. */
export type Runner = (job: { request: RunRequest; taken: TakenRequest; card: string; projectId: number; signal: AbortSignal }) => Promise<RunResult>;

/** A request older than this when the daemon first sees it is not run: nobody is waiting for it. */
export const REQUEST_TTL_MS = 10 * 60_000;

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Runs {
  /** The work in progress, one at a time: its request, the request's message, and how to stop it. */
  private current: { run: RunRequest; message: number; stop: AbortController } | null = null;
  /** Requests their owner cancelled, by message id, so nothing more is done for them (R-030). */
  readonly cancelled = new Set<number>();

  constructor(
    private readonly client: AgentClient,
    private readonly runner: Runner,
    /** Why this machine will not run a request, checked before it is claimed. The plugin checks its repository and sandbox. */
    private readonly refuse: (run: RunRequest) => Promise<string | undefined> = async () => undefined,
  ) {}

  /** The request being run, while one is. */
  get running() {
    return this.current?.run ?? null;
  }

  /**
   * Reports the run that the daemon was in when it stopped as failed, so its card does not stay
   * claimed with nothing running (K-46). Called once at start, after the first check-in.
   */
  async recover() {
    const left = this.client.running;
    if (!left) return;
    await this.fail(left, 'The daemon stopped during the run.');
    await this.client.saveRunning(undefined);
  }

  /** Runs a request addressed to this account, or stops one its owner cancels, and reports. Anything else is ignored. */
  async handle(message: OpenedMessage) {
    const run = message.content?.run;
    if (message.security !== 'encrypted' || !run) return;
    if (run.kind === 'cancel') {
      // The id is the server's, so at worst a changed server stops another of the owner's runs.
      if (message.senderId !== this.client.owner) return;
      this.cancelled.add(run.request);
      if (this.current?.message === run.request) this.current.stop.abort();
      return;
    }
    if (run.kind !== 'request' || run.runtime !== this.client.id) return;
    // A Claude Code session takes only its repository's runs; another one's is the session there's (D-094).
    if (this.client.repo && run.repo !== this.client.repo) return;
    // A copy the server posted again under a new id: nothing runs, and nothing answers it (K-47).
    if (!this.client.remember(message.clientId ?? '', run.sentAt ?? 0)) return;
    const taken: TakenRequest = { message: message.id, conversation: message.conversationId, card: run.card };
    const failed = (note: string) => this.fail(taken, note);
    // The signature checked the sender against the keys pinned for them, so the id is the owner's.
    if (message.senderId !== this.client.owner) {
      return failed(`Only ${this.client.users.get(this.client.owner!)?.displayName ?? 'my owner'} hands cards to me.`);
    }
    // The time the owner's page signed, not the server's, which could play an old request again (K-42).
    if (!run.sentAt || Math.abs(Date.now() - run.sentAt) > REQUEST_TTL_MS) return failed('The request was not sent in the last 10 minutes.');
    if (this.running) return failed(`I am busy with ${this.running.card}.`);
    const projectId = this.client.conversations.get(message.conversationId)?.projectId;
    return this.execute(taken, run, async (signal) => {
      const refused = await this.refuse(run);
      if (refused) throw new Error(refused);
      // The card must be on the board of the project the request is in, whose repository the run uses.
      // Whoever wrote it, the owner chose to run it.
      const doc = this.client.docs.find((d) => d.id === run.docId && this.client.conversations.get(d.conversationId)?.projectId === projectId);
      const card = doc && (await this.client.sections(doc)).find((s) => s.id === run.section);
      if (!projectId || !card) throw new Error('The card is not on the board.');
      await this.report(taken, { kind: 'claimed' }, `I am on ${run.card}: ${run.title}`);
      return this.runner({ request: run, taken, card: card.text, projectId, signal });
    });
  }

  /**
   * Another round on a request this account ran: fixing its pull request after CI failed, a
   * conflict or a review (R-030). Reports fixing, then done or failed, as a run does. False when
   * something runs already, so the caller tries again later.
   */
  async follow(taken: TakenRequest, run: RunRequest, why: string, last: RunResult, work: (signal: AbortSignal) => Promise<RunResult>) {
    if (this.running) return false;
    await this.execute(taken, run, async (signal) => {
      await this.report(taken, { kind: 'fixing', note: why, branch: last.branch, pull: last.pull }, `I am fixing ${run.card}: ${why}`);
      return work(signal);
    });
    return true;
  }

  fail(taken: TakenRequest, note: string) {
    return this.report(taken, { kind: 'failed', note }, `I could not run ${taken.card}: ${note}`);
  }

  /**
   * Does one piece of work and reports how it ended. Taken before the first wait, so a request
   * from the same check-in finds the account busy. Kept in the file while it runs (K-46).
   */
  private async execute(taken: TakenRequest, run: RunRequest, work: (signal: AbortSignal) => Promise<RunResult>) {
    const stop = new AbortController();
    this.current = { run, message: taken.message, stop };
    this.client.busy = true;
    try {
      await this.client.saveRunning(taken);
      await this.done(taken, await work(stop.signal));
    } catch (error) {
      await this.fail(taken, messageOf(error));
    } finally {
      this.current = null;
      this.client.busy = false;
    }
    // Only once a report got through. Otherwise the next start sends one.
    await this.client.saveRunning(undefined);
  }

  private done(taken: TakenRequest, result: RunResult) {
    const where = `${result.branch}${result.pull ? ` (${result.pull.repo}#${result.pull.number})` : ''}`;
    return this.report(taken, { kind: 'done', ...result }, `I finished ${taken.card} on ${where}.${result.note ? ` ${result.note}` : ''}`);
  }

  private report(taken: TakenRequest, reply: Omit<RunReport, 'request'>, text: string) {
    return this.client.send(taken.conversation, { text, run: { ...reply, request: taken.message } });
  }
}
