// Runs a board card when a teammate asks for it (R-027, D-086). A request is a sealed message in
// the project's #general whose `run` field names the card and this account. The daemon claims it,
// hands the card to the runner, which is where the coding agent runs, then reports done or failed
// and puts the branch into the card's status line. Every report is a message of its own that
// names the request, and pages fold them into one card.
import type { DocDTO, RunReport, RunRequest } from '../shared/types.ts';
import type { AgentClient, OpenedMessage } from './client.ts';

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

  /** Runs a request addressed to this account, and reports. Anything else is ignored. */
  async handle(message: OpenedMessage) {
    const run = message.content?.run;
    if (message.security !== 'encrypted' || run?.kind !== 'request' || run.runtime !== this.client.id) return;
    const report = (reply: Omit<RunReport, 'request'>, text: string) =>
      this.client.send(message.conversationId, { text, run: { ...reply, request: message.id } });
    const failed = (note: string) => report({ kind: 'failed', note }, `I could not run ${run.card}: ${note}`);
    const nameOf = (userId: number | null, fallback: string) => (userId !== null && this.client.users.get(userId)?.displayName) || fallback;
    if (!this.client.trusts(message.senderId)) return failed(`${nameOf(message.senderId, 'this account')} is not allowed to run cards here.`);
    if (Date.now() - message.createdAt > REQUEST_TTL_MS) return failed('The request is older than 10 minutes.');
    if (this.running) return failed(`I am busy with ${this.running.card}.`);

    // Taken before the first wait, so a request from the same check-in finds the account busy.
    this.running = run;
    this.client.busy = true;
    try {
      const projectId = this.client.conversations.get(message.conversationId)?.projectId;
      // The card must be on the board of the project the request is in, whose repository the run uses.
      const doc = this.client.docs.find((d) => d.id === run.docId && this.client.conversations.get(d.conversationId)?.projectId === projectId);
      const card = doc && (await this.client.sections(doc)).find((s) => s.id === run.section);
      if (!projectId || !doc || !card) throw new Error('The card is not on the board.');
      // The card's text is the agent's prompt, so whoever saved it last must be allowed too.
      if (!this.client.trusts(card.authorId)) throw new Error(`${nameOf(card.authorId, 'Someone')} changed the card last, and is not allowed to run cards here.`);
      await report({ kind: 'claimed' }, `I am on ${run.card}: ${run.title}`);
      const result = await this.runner({ request: run, card: card.text, projectId });
      const where = `${result.branch}${result.pull ? ` (${result.pull.repo}#${result.pull.number})` : ''}`;
      // The work is done whether or not the card's status line can be written now.
      const unset = await this.setStatus(doc, card.id, `In progress on branch ${where}`).then(
        () => '',
        (error: unknown) => ` I could not update the card's status line: ${error instanceof Error ? error.message : String(error)}`,
      );
      await report({ kind: 'done', ...result }, `I finished ${run.card} on ${where}.${result.note ? ` ${result.note}` : ''}${unset}`);
    } catch (error) {
      await failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = null;
      this.client.busy = false;
    }
  }

  /**
   * Writes the card's status line into its text as it is now, leaving the rest as it is. A card
   * without one gets it under its heading. Text from someone not allowed is left alone, so the
   * agent never saves it as its own, which would let it run later.
   */
  private setStatus(doc: DocDTO, section: string, status: string) {
    const line = `Status: ${status}.`;
    return this.client.editSection(doc, section, (card) => {
      if (!card) throw new Error('the card is no longer on the board.');
      if (!this.client.trusts(card.authorId)) throw new Error('someone who is not allowed changed it meanwhile.');
      const text = /^Status:/m.test(card.text) ? card.text.replace(/^Status:.*$/m, line) : card.text.replace(/^(.*)$/m, `$1\n\n${line}`);
      return { text, pos: card.pos };
    });
  }
}
