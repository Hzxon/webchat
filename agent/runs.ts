// Runs a board card when the agent's owner asks for it (R-027, D-086, D-089). A request is a sealed
// message in the project's #general whose `run` field names the card and this account. The daemon
// claims it, hands the card to the runner, which is where the coding agent runs, then reports done
// or failed. Every report is a message of its own that names the request, and pages fold them
// into one card.
import type { RunReport, RunRequest } from '../shared/types.ts';
import type { AgentClient, OpenedMessage, TakenRequest } from './client.ts';

export interface RunResult {
  branch: string;
  pull?: { repo: string; number: number };
  /** A line for the done report, such as what the agent said last. */
  note?: string;
}

/** Does the work of one run, given the card as Markdown. Where the coding agent runs. */
export type Runner = (job: { request: RunRequest; card: string; projectId: number }) => Promise<RunResult>;

/** A request older than this when the daemon first sees it is not run: nobody is waiting for it. */
export const REQUEST_TTL_MS = 10 * 60_000;

export class Runs {
  /** The request being run, while one is. One run at a time. */
  running: RunRequest | null = null;

  constructor(
    private readonly client: AgentClient,
    private readonly runner: Runner,
  ) {}

  /**
   * Reports the run that the daemon was in when it stopped as failed, so its card does not stay
   * claimed with nothing running (K-46). Called once at start, after the first check-in.
   */
  async recover() {
    const left = this.client.running;
    if (!left) return;
    await this.failed(left, 'The daemon stopped during the run.');
    await this.client.saveRunning(undefined);
  }

  /** Runs a request addressed to this account, and reports. Anything else is ignored. */
  async handle(message: OpenedMessage) {
    const run = message.content?.run;
    if (message.security !== 'encrypted' || run?.kind !== 'request' || run.runtime !== this.client.id) return;
    const taken: TakenRequest = { message: message.id, conversation: message.conversationId, card: run.card };
    const failed = (note: string) => this.failed(taken, note);
    // The signature checked the sender against the keys pinned for them, so the id is the owner's.
    if (message.senderId !== this.client.owner) {
      return failed(`Only ${this.client.users.get(this.client.owner!)?.displayName ?? 'my owner'} hands cards to me.`);
    }
    // The time the owner's page signed, not the server's, which could play an old request again (K-42).
    if (!run.sentAt || Math.abs(Date.now() - run.sentAt) > REQUEST_TTL_MS) return failed('The request was not sent in the last 10 minutes.');
    if (this.running) return failed(`I am busy with ${this.running.card}.`);

    // Taken before the first wait, so a request from the same check-in finds the account busy.
    this.running = run;
    this.client.busy = true;
    try {
      await this.client.saveRunning(taken);
      const projectId = this.client.conversations.get(message.conversationId)?.projectId;
      // The card must be on the board of the project the request is in, whose repository the run uses.
      // Whoever wrote it, the owner chose to run it.
      const doc = this.client.docs.find((d) => d.id === run.docId && this.client.conversations.get(d.conversationId)?.projectId === projectId);
      const card = doc && (await this.client.sections(doc)).find((s) => s.id === run.section);
      if (!projectId || !card) throw new Error('The card is not on the board.');
      await this.report(taken, { kind: 'claimed' }, `I am on ${run.card}: ${run.title}`);
      const result = await this.runner({ request: run, card: card.text, projectId });
      const where = `${result.branch}${result.pull ? ` (${result.pull.repo}#${result.pull.number})` : ''}`;
      await this.report(taken, { kind: 'done', ...result }, `I finished ${run.card} on ${where}.${result.note ? ` ${result.note}` : ''}`);
    } catch (error) {
      await failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = null;
      this.client.busy = false;
    }
    // Only once a report got through. Otherwise the next start sends one.
    await this.client.saveRunning(undefined);
  }

  private report(taken: TakenRequest, reply: Omit<RunReport, 'request'>, text: string) {
    return this.client.send(taken.conversation, { text, run: { ...reply, request: taken.message } });
  }

  private failed(taken: TakenRequest, note: string) {
    return this.report(taken, { kind: 'failed', note }, `I could not run ${taken.card}: ${note}`);
  }
}
