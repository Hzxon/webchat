// What the plugin does when a harness asks before an action (docs/decisions/harness-approvals.md):
// the runner's rulebook answers what it can alone, a grant for this run answers an action it allowed before,
// and anything else is a sealed question in the owner's direct chat. Only the owner's signed answer
// counts, once, within 10 minutes of its signing, as a `fix` does (D-105). Everything here lives in
// memory, so no rule outlives a run or a restart.
import { permitHash } from '../shared/e2ee.ts';
import { ASK_WAIT_MS, type PermitDTO } from '../shared/types.ts';
import type { AgentClient, OpenedMessage } from './client.ts';
import type { Ask, Reply } from './harness.ts';
import { REQUEST_TTL_MS } from './runs.ts';
import { Quiet } from './runner.ts';

/** Open questions of a run at once, and in all: a model that loops must not buzz the owner's phone. */
const OPEN = 3;
const PER_RUN = 25;
/** The longest detail a question shows, so the owner reads all of what they allow. */
const DETAIL = 1500;

/** What the model is told when it is refused. Never the owner's words or the model's own. */
const NO = {
  owner: 'Your owner said no. Do not try it again: do something else, or stop.',
  many: 'Your owner was asked too many times. Do not ask again: do something else, or stop.',
  long: 'That is too long for your owner to read whole. Do it in smaller steps.',
};

type What = Extract<PermitDTO, { kind: 'question' }>['what'];
const WHAT: Record<Ask['kind'], What> = { execute: 'run', edit: 'edit', delete: 'edit', move: 'edit', read: 'read', search: 'read', fetch: 'fetch', think: 'other', switch_mode: 'other', other: 'other' };
const WORDS: Record<What, string> = { run: 'run a command', edit: 'change a file', read: 'read a file', fetch: 'reach the web', other: 'use a tool' };

type Decision = 'once' | 'run' | 'deny' | 'stopped';

interface Pending {
  session: string;
  chat: number;
  seen: string;
  at: number;
  settle: (decision: Decision | Error) => void;
}

export class Permits {
  private readonly pending = new Map<string, Pending>();
  /** The actions the owner allowed for a run, by session: the same tool, kind and detail exactly. */
  private readonly grants = new Map<string, Set<string>>();
  private readonly asked = new Map<string, number>();
  /** The sessions with a turn running, whose grants a sweep keeps. */
  private readonly active = new Set<string>();

  constructor(
    private readonly client: AgentClient,
    /** Whether a message is the owner's, in their direct chat. */
    private readonly owns: (message: OpenedMessage) => boolean,
  ) {}

  /** Tells the pane how a question ended. */
  private say(chat: number, to: string, outcome: Extract<PermitDTO, { kind: 'settled' }>['outcome']) {
    const text = { allowed: 'Allowed.', allowedForRun: 'Allowed for this run.', denied: 'Denied.', expired: 'No answer came within 7 days.', stopped: 'Stopped.', stale: 'That answer is older than 10 minutes. Answer again.' }[outcome];
    return this.client.send(chat, { text, permit: { kind: 'settled', to, outcome } }).catch(() => undefined);
  }

  /**
   * What one turn of `session` gets: `ask`, which the harness calls, `quiet`, which holds the turn's
   * silence timer while a question waits, and `done`, which settles what the turn leaves open.
   */
  forTurn({ session, chat, thread }: { session: string; chat: number; thread: { request: number } | { to: string } }) {
    const quiet = new Quiet();
    const mine = new Set<string>();
    this.active.add(session);
    const ask = async (action: Ask): Promise<Reply> => {
      if (action.detail.length > DETAIL) return { allow: false, message: NO.long };
      const key = [action.tool, action.kind, action.detail].join('\n');
      if (this.grants.get(session)?.has(key)) return { allow: true };
      const open = [...mine].filter((cid) => this.pending.has(cid)).length;
      const total = (this.asked.get(session) ?? 0) + 1;
      if (open >= OPEN || total > PER_RUN) return { allow: false, message: NO.many };
      this.asked.set(session, total);
      const what = WHAT[action.kind];
      const question: Extract<PermitDTO, { kind: 'question' }> = { kind: 'question', ...thread, what, detail: action.detail, expires: Date.now() + ASK_WAIT_MS };
      const sent = await this.client.send(chat, { text: `Your agent asks your permission to ${WORDS[what]}:\n${action.detail}`, permit: question });
      const cid = sent.clientId!;
      mine.add(cid);
      const seen = await permitHash(question);
      const decision = await quiet.during(new Promise<Decision>((resolve, reject) => this.pending.set(cid, { session, chat, seen, at: Date.now(), settle: (d) => (d instanceof Error ? reject(d) : resolve(d)) })));
      if (decision === 'run') (this.grants.get(session) ?? this.grants.set(session, new Set()).get(session)!).add(key);
      void this.say(chat, cid, { once: 'allowed', run: 'allowedForRun', deny: 'denied', stopped: 'stopped' }[decision] as 'allowed');
      return decision === 'once' || decision === 'run' ? { allow: true } : { allow: false, message: NO.owner };
    };
    const done = () => {
      this.active.delete(session);
      for (const cid of mine) {
        this.pending.get(cid)?.settle('stopped');
        this.pending.delete(cid);
      }
    };
    return { ask, quiet, done };
  }

  /** The owner's answer to a question. Anything else, or anyone else's, does nothing. */
  async answer(message: OpenedMessage) {
    const permit = message.content?.permit;
    if (permit?.kind !== 'answer' || !this.owns(message) || !this.client.remember(message.clientId ?? '', permit.sentAt)) return;
    const pending = this.pending.get(permit.to);
    if (!pending || pending.chat !== message.conversationId) return;
    // The time the owner's page signed, not the server's, which could play an old answer again (K-42). The question stays open.
    if (Math.abs(Date.now() - permit.sentAt) > REQUEST_TTL_MS) return void (await this.say(pending.chat, permit.to, 'stale'));
    if (permit.seen !== pending.seen) return;
    // Taken out first, so the question counts once.
    this.pending.delete(permit.to);
    pending.settle(permit.decision);
  }

  /** Ends the questions nobody answered in 7 days, which fails their turns; the wall clock counts, so a sleeping laptop does too. */
  async expire(now = Date.now()) {
    for (const [cid, pending] of [...this.pending]) {
      if (now - pending.at <= ASK_WAIT_MS) continue;
      this.pending.delete(cid);
      pending.settle(new Error('No answer came within 7 days.'));
      await this.say(pending.chat, cid, 'expired');
    }
  }

  /** Forgets what a run was allowed, once its session is over. */
  drop(session: string) {
    this.grants.delete(session);
    this.asked.delete(session);
  }

  /** Drops the grants of every session that is not live, so none outlives its run. */
  sweep(live: Set<string>) {
    for (const session of [...this.grants.keys(), ...this.asked.keys()]) if (!live.has(session) && !this.active.has(session)) this.drop(session);
  }
}
