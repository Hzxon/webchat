// The owner's conversations with their agent (R-035, D-102). The owner sends a prompt in their
// direct chat with the agent, and its sealed `prompt` field names the repository. The laptop's
// plugin answers it with a turn of its background Claude in that repository's folder (R-036), and
// each reply the owner sends resumes that Claude session. Only the owner's messages count (D-089):
// a prompt, reply or cancel from anyone else does nothing. Answers and failures are messages that
// name the conversation by its prompt's signed client id, as run reports name their request
// (D-086).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { LIMITS, type CardAskDTO, type CardDraftDTO, type PermissionMode } from '../shared/types.ts';
import type { AgentClient, OpenedMessage } from './client.ts';
import { messageOf, REQUEST_TTL_MS } from './runs.ts';

/** A conversation its owner leaves this long ends, and its scratch copy goes. */
export const CONVERSATION_TTL_MS = 24 * 60 * 60_000;

/** One conversation, kept on disk so a restart can still resume it. */
export interface Conversation {
  /** Its prompt's client id, which every later message names. */
  root: string;
  chat: number;
  /** The repository its prompt names, as "owner/name", or none for a question about the board alone (R-038). */
  repo?: string;
  /** The harness its prompt names, or none for the host's; the plugin writes the one that answered, which every reply resumes. */
  harness?: string;
  /** The background Claude session its turns share. A new one until a turn has answered. */
  session: string;
  answered: boolean;
  /** The prompt's words, until a turn has answered, so a turn that starts afresh still has them. */
  prompt?: string;
  /** The conversation's scratch copy of the repository, while it has one. The plugin makes it. */
  scratch?: string;
  /** The commit of origin's default branch that the scratch copy holds, under any commits Claude made there. */
  fetched?: string;
  /** Set while a turn runs, so a restart knows it was cut short. */
  working?: boolean;
  /** When it last moved. */
  last: number;
  ended?: boolean;
  /** The owner's page can show a question of the agent, so a turn may ask before an action (docs/decisions/harness-approvals.md). */
  asks?: true;
  /** Its owner typed the prompt, so it may run in their own setup; Check again and `webchat-agent card` never set it (D-157). */
  own?: true;
  /** Its owner's page shows the session's steps, so the turns send them (R-072). */
  events?: true;
  /** The model and permission mode its owner's controls picked last (R-072). */
  model?: string;
  mode?: PermissionMode;
  /** Whether its turns ran in the owner's own setup, which every reply keeps. */
  ownSetup?: boolean;
  /** The board its owner's page picked for the prompt, the only one its briefs hold (D-104). */
  project?: number;
  /** Each card and held decision in the brief, by its id, with its place and hash, so a draft names only what it saw (D-104, D-116). */
  seen?: Record<string, { doc: string; section: string; hash: string }>;
  /** The open pull requests as the last brief listed them, so a reply lists them again only when they changed (R-041). */
  pulls?: string;
}

/** One turn: the owner's words in, the answer out, with drafts when they asked for them. Where the background Claude runs. */
export type Answerer = (job: { conversation: Conversation; input: string; resume: boolean; signal: AbortSignal; card?: CardAskDTO }) => Promise<{ reply: string; drafts?: CardDraftDTO[] }>;

/** What the harness that ran a session writes before another takes it over (D-156). */
const summaryAsk = (harness: string) =>
  `Your owner hands this session over to ${harness}, which knows only what you write now and the files. In reply, write the summary it starts from: the goal, what is done, what is next, and anything it must not redo. Plain words, no drafts.`;

/** How the next harness's session starts: the summary, which its owner read and may have edited, as their words (D-156). */
const handoverBrief = (summary: string) => `Your owner handed this session over to you from another coding agent, with this summary of it. Go on from it.\n\n${summary.trim()}`;

export class Conversations {
  private list: Conversation[] = [];
  /** Each conversation's turns, one after another, and how to stop them. Not on disk. */
  private readonly turns = new Map<string, { chain: Promise<void>; stops: Set<AbortController> }>();
  /** The file's last write, which the next one waits for, so two writes never interleave. */
  private written: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: AgentClient,
    private readonly file: string,
    private readonly answer: Answerer,
    /** Called when a conversation ends, so its harness can end what it keeps for the session. */
    private readonly onEnd: (conversation: Conversation) => void = () => undefined,
    /** Removes an ended conversation's scratch copy, wherever it is kept. */
    private readonly drop: (scratch: string) => Promise<void> = (scratch) => fs.rm(scratch, { recursive: true, force: true }),
  ) {}

  /** Whether a turn runs or waits for one, which keeps an agent that goes to sleep awake (K-66). */
  get busy() {
    return [...this.turns.values()].some((t) => t.stops.size > 0);
  }

  /** Reads the file. One that does not parse is a lost list, not a reason to stop the plugin. */
  async load() {
    try {
      this.list = JSON.parse(await fs.readFile(this.file, 'utf8')) as Conversation[];
    } catch {
      this.list = [];
    }
  }

  /** Reports the turns a restart cut short, so their owner is not left waiting. Called after the first check-in. */
  async recover() {
    for (const conversation of this.list.filter((c) => c.working)) {
      conversation.working = false;
      if (!conversation.answered) conversation.session = randomUUID();
      await this.say(conversation, 'failed', 'I stopped, because Claude Code closed on your laptop. Send it again.').catch(() => undefined);
    }
    await this.save();
  }

  /** Acts on one message of a conversation. Anything else is ignored. Nothing waits before a turn is queued. */
  async handle(message: OpenedMessage) {
    const prompt = message.content?.prompt;
    // Only the owner's prompts, replies and cancels; the plugin takes their clones (R-036).
    if (message.security !== 'encrypted' || !prompt || (prompt.kind !== 'prompt' && prompt.kind !== 'reply' && prompt.kind !== 'cancel')) return;
    // The owner, in their direct chat with this agent; the signature checked the sender against the pins (D-089).
    if (message.senderId !== this.client.owner || this.client.conversations.get(message.conversationId)?.type !== 'direct') return;
    const text = message.content!.text;
    const conversation =
      prompt.kind === 'prompt'
        ? message.clientId
          ? { root: message.clientId, chat: message.conversationId, repo: prompt.repo, harness: prompt.harness, session: randomUUID(), answered: false, prompt: text, last: Date.now(), project: prompt.project, asks: prompt.asks, ...(prompt.own && { own: prompt.own }), ...(prompt.events && { events: prompt.events }), ...(prompt.model && { model: prompt.model }), ...(prompt.mode && { mode: prompt.mode }) }
          : undefined
        : this.list.find((c) => c.root === prompt.to && c.chat === message.conversationId);
    // A copy the server posted again under a new id does nothing (K-47).
    if (!this.client.remember(message.clientId ?? '', prompt.sentAt)) return;
    // One laptop answers every conversation, so a reply it cannot place hears so: one gone after a
    // week, or kept by a session from before R-036.
    if (!conversation) {
      if (prompt.kind === 'reply') await this.client.send(message.conversationId, { text: 'I no longer know this conversation. Start a new one.', prompt: { kind: 'failed', to: prompt.to } });
      return;
    }
    // The time the owner's page signed, not the server's, which could play an old message again (K-42).
    // A prompt skipped so stays, and nothing runs until a reply asks again.
    if (Math.abs(Date.now() - prompt.sentAt) > REQUEST_TTL_MS) {
      if (prompt.kind === 'prompt') {
        this.list.push(conversation);
        await this.save();
      }
      return this.say(conversation, 'failed', 'I got this more than 10 minutes after you sent it, so I skipped it. Reply to ask again.');
    }
    if (conversation.ended) return this.say(conversation, 'failed', 'This conversation ended after a day with no reply. Start a new one.');
    if (prompt.kind === 'cancel') {
      for (const stop of this.turns.get(conversation.root)?.stops ?? []) stop.abort();
      return;
    }
    // Queued before anything waits, so a reply or cancel in the same check-in comes after it.
    if (prompt.kind === 'prompt') this.list.push(conversation);
    // A reply's controls hold for the turns after it (R-072).
    if (prompt.model) conversation.model = prompt.model;
    if (prompt.mode) conversation.mode = prompt.mode;
    const handover = prompt.kind === 'reply' ? prompt.handover : undefined;
    // The summary as its owner saw and edited it starts the other harness's own session, in the same
    // folder and thread; the harness that ran it ends (D-156).
    if (handover?.summary !== undefined) {
      this.onEnd(conversation);
      Object.assign(conversation, { harness: handover.harness, session: randomUUID(), answered: false, ownSetup: undefined });
      conversation.prompt = handoverBrief(handover.summary);
      return this.turn(conversation, conversation.prompt);
    }
    return this.turn(conversation, text, prompt.card, handover?.harness);
  }

  /** Takes a turn after the conversation's last one, and posts its answer, or why there is none. */
  /** With `handover`, the turn writes the summary for that harness, which goes to the owner to read and edit first (D-156). */
  private turn(conversation: Conversation, input: string, card?: CardAskDTO, handover?: string) {
    const turns = this.turns.get(conversation.root) ?? { chain: Promise.resolve(), stops: new Set<AbortController>() };
    this.turns.set(conversation.root, turns);
    const stop = new AbortController();
    turns.stops.add(stop);
    turns.chain = turns.chain.then(async () => {
      try {
        if (stop.signal.aborted) throw new Error('Cancelled.');
        conversation.working = true;
        await this.save();
        // Until a turn has answered, each turn starts afresh with the prompt and what came since.
        const words = conversation.answered || input === conversation.prompt ? input : `${conversation.prompt}\n\n${input}`;
        const { reply, drafts = [] } = await this.answer({ conversation, input: handover ? summaryAsk(handover) : words, resume: conversation.answered, signal: stop.signal, card });
        conversation.answered = true;
        delete conversation.prompt;
        if (handover) {
          await this.client.send(conversation.chat, { text: reply.slice(0, LIMITS.messageLength), prompt: { kind: 'summary', to: conversation.root, harness: handover } });
          return;
        }
        for (const part of parts(reply)) await this.say(conversation, 'answer', part);
        // Each a message of its own, so the answer's parts and every draft fit in one (D-104).
        for (const card of drafts) {
          await this.client.send(conversation.chat, { text: `${card.kind === 'D' ? 'Decision' : 'Card'} draft: ${card.title}`, prompt: { kind: 'answer', to: conversation.root, card } });
        }
      } catch (error) {
        // Claude may have kept the session it started, so a turn that starts afresh takes a new one.
        if (!conversation.answered) conversation.session = randomUUID();
        if (!conversation.answered && input !== conversation.prompt) conversation.prompt = `${conversation.prompt}\n\n${input}`;
        await this.say(conversation, 'failed', stop.signal.aborted ? 'I stopped, as you asked.' : `I could not answer. ${messageOf(error)}`).catch(() => undefined);
      } finally {
        turns.stops.delete(stop);
        conversation.working = false;
        conversation.last = Date.now();
        await this.save();
      }
    });
    return turns.chain;
  }

  private say(conversation: Conversation, kind: 'answer' | 'failed', text: string) {
    return this.client.send(conversation.chat, { text, prompt: { kind, to: conversation.root } });
  }

  /**
   * Ends the conversations their owner left for a day, and removes their scratch copies, again on a
   * later sweep if a removal failed. An ended one stays on disk for a week, so a late reply hears
   * that it ended.
   */
  async sweep(now = Date.now()) {
    let changed = false;
    for (const conversation of this.list) {
      if (!conversation.ended && !this.turns.get(conversation.root)?.stops.size && now - conversation.last > CONVERSATION_TTL_MS) {
        conversation.ended = changed = true;
        this.onEnd(conversation);
        this.turns.delete(conversation.root);
      }
      if (conversation.ended && conversation.scratch) {
        await this.drop(conversation.scratch);
        delete conversation.scratch;
        changed = true;
      }
    }
    const kept = this.list.filter((c) => !c.ended || now - c.last < 7 * CONVERSATION_TTL_MS);
    if (changed || kept.length < this.list.length) {
      this.list = kept;
      await this.save();
    }
  }

  private save() {
    this.written = this.written
      .catch(() => undefined)
      .then(() => fs.writeFile(this.file, JSON.stringify(this.list, null, 2)));
    return this.written.catch(() => undefined);
  }
}

/**
 * An answer as messages no longer than a message may be, cut after a line break where one is near,
 * and never inside a surrogate pair. Joined, they are the answer again, which the pane shows whole.
 */
export function parts(text: string) {
  const out: string[] = [];
  let rest = text.trim() || '(No answer.)';
  while (rest.length > LIMITS.messageLength) {
    const cut = rest.lastIndexOf('\n', LIMITS.messageLength - 1) + 1;
    if (cut > LIMITS.messageLength / 2) {
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    const code = rest.charCodeAt(LIMITS.messageLength - 1);
    const at = code >= 0xd800 && code <= 0xdbff ? LIMITS.messageLength - 1 : LIMITS.messageLength;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return [...out, rest];
}
