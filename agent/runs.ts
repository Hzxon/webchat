// Runs a board card when a teammate asks for it (R-027, D-086). A request is a sealed message in
// the project's #general whose `run` field names the card and this account. The daemon claims it,
// hands the card to the runner, which is where the coding agent runs, then reports done or failed
// and puts the branch into the card's status line. Every report is a message of its own that
// names the request, and pages fold them into one card.
import type { DocDTO, RunReport, RunRequest } from '../shared/types.ts';
import type { AgentClient, DocSection, OpenedMessage } from './client.ts';

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
    const sender = message.senderId === null ? null : this.client.users.get(message.senderId);
    if (!sender || !this.client.allows(sender.username)) return failed(`${sender?.displayName ?? 'this account'} is not allowed to run cards here.`);
    if (Date.now() - message.createdAt > REQUEST_TTL_MS) return failed('The request is older than 10 minutes.');
    if (this.running) return failed(`I am busy with ${this.running.card}.`);
    const projectId = this.client.conversations.get(message.conversationId)?.projectId;
    const doc = this.client.docs.find((d) => d.id === run.docId);
    const card = doc && (await this.client.sections(doc)).find((s) => s.id === run.section);
    if (!projectId || !doc || !card) return failed('The card is not on the board.');

    this.running = run;
    try {
      await report({ kind: 'claimed' }, `I am on ${run.card}: ${run.title}`);
      const result = await this.runner({ request: run, card: card.text, projectId });
      const where = `${result.branch}${result.pull ? ` (${result.pull.repo}#${result.pull.number})` : ''}`;
      await this.setStatus(doc, card, `In progress on branch ${where}`);
      await report({ kind: 'done', ...result }, `I finished ${run.card} on ${where}.${result.note ? ` ${result.note}` : ''}`);
    } catch (error) {
      await failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = null;
    }
  }

  /** Writes the card's status line, leaving the rest of its text as it is. A card without one gets it under its heading. */
  private setStatus(doc: DocDTO, card: DocSection, status: string) {
    const line = `Status: ${status}.`;
    const text = /^Status:/m.test(card.text) ? card.text.replace(/^Status:.*$/m, line) : card.text.replace(/^(.*)$/m, `$1\n\n${line}`);
    return this.client.replaceSection(doc, card.id, { text, pos: card.pos });
  }
}
