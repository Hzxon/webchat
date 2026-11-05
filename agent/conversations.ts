// The owner's conversations with their agent (R-035, D-102). The owner sends a prompt in their
// direct chat with the agent, and its sealed `prompt` field names the repository. The Claude Code
// session open in that repository answers it with a turn of its background Claude, and each reply
// the owner sends resumes that Claude session. Only the owner's messages count (D-089): a prompt,
// reply or cancel from anyone else does nothing. Answers and failures are messages that name the
// conversation by its prompt's signed client id, as run reports name their request (D-086).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { LIMITS } from '../shared/types.ts';
import type { AgentClient, OpenedMessage } from './client.ts';
import { messageOf, REQUEST_TTL_MS } from './runs.ts';

/** A conversation its owner leaves this long ends, and its scratch copy goes. */
export const CONVERSATION_TTL_MS = 24 * 60 * 60_000;

/** One conversation, kept on disk so a restart can still resume it. */
export interface Conversation {
  /** Its prompt's client id, which every later message names. */
  root: string;
  chat: number;
  /** The background Claude session its turns share. A new one until a turn has answered. */
  session: string;
  answered: boolean;
  /** The prompt's words, until a turn has answered, so a turn that starts afresh still has them. */
  prompt?: string;
  /** The conversation's scratch copy of the repository, while it has one. The plugin makes it. */
  scratch?: string;
  /** Set while a turn runs, so a restart knows it was cut short. */
  working?: boolean;
  /** When it last moved. */
  last: number;
  ended?: boolean;
}

/** One turn: the owner's words in, the answer out. Where the background Claude runs. */
export type Answerer = (job: { conversation: Conversation; input: string; resume: boolean; signal: AbortSignal }) => Promise<string>;

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
  ) {}

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
    if (message.security !== 'encrypted' || !prompt || prompt.kind === 'answer' || prompt.kind === 'failed') return;
    // The owner, in their direct chat with this agent; the signature checked the sender against the pins (D-089).
    if (message.senderId !== this.client.owner || this.client.conversations.get(message.conversationId)?.type !== 'direct') return;
    // A prompt is the session's open in the repository it names, and a reply the session's that has its conversation (D-094).
    const text = message.content!.text;
    const conversation =
      prompt.kind === 'prompt'
        ? prompt.repo === this.client.repo && message.clientId
          ? { root: message.clientId, chat: message.conversationId, session: randomUUID(), answered: false, prompt: text, last: Date.now() }
          : undefined
        : this.list.find((c) => c.root === prompt.to && c.chat === message.conversationId);
    // A copy the server posted again under a new id does nothing (K-47).
    if (!conversation || !this.client.remember(message.clientId ?? '', prompt.sentAt)) return;
    // The time the owner's page signed, not the server's, which could play an old message again (K-42).
    if (Math.abs(Date.now() - prompt.sentAt) > REQUEST_TTL_MS) return this.say(conversation, 'failed', 'I got this more than 10 minutes after you sent it, so I skipped it. Send it again.');
    if (conversation.ended) return this.say(conversation, 'failed', 'This conversation ended after a day with no reply. Start a new one.');
    if (prompt.kind === 'cancel') {
      for (const stop of this.turns.get(conversation.root)?.stops ?? []) stop.abort();
      return;
    }
    // Queued before anything waits, so a reply or cancel in the same check-in comes after it.
    if (prompt.kind === 'prompt') this.list.push(conversation);
    return this.turn(conversation, text);
  }

  /** Takes a turn after the conversation's last one, and posts its answer, or why there is none. */
  private turn(conversation: Conversation, input: string) {
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
        const reply = await this.answer({ conversation, input: words, resume: conversation.answered, signal: stop.signal });
        conversation.answered = true;
        delete conversation.prompt;
        for (const part of parts(reply)) await this.say(conversation, 'answer', part);
      } catch (error) {
        // Claude may have kept the session it started, so a turn that starts afresh takes a new one.
        if (!conversation.answered) conversation.session = randomUUID();
        if (!conversation.answered && input !== conversation.prompt) conversation.prompt = `${conversation.prompt}\n\n${input}`;
        await this.say(conversation, 'failed', stop.signal.aborted ? 'I stopped, as you asked.' : `I could not answer: ${messageOf(error)}`).catch(() => undefined);
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
        this.turns.delete(conversation.root);
      }
      if (conversation.ended && conversation.scratch) {
        await fs.rm(conversation.scratch, { recursive: true, force: true });
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
 * An answer as messages no longer than a message may be, cut at a line break where one is near,
 * and never inside a surrogate pair. Only the line break at a cut goes.
 */
export function parts(text: string) {
  const out: string[] = [];
  let rest = text.trim() || '(No answer.)';
  while (rest.length > LIMITS.messageLength) {
    const cut = rest.lastIndexOf('\n', LIMITS.messageLength);
    if (cut > LIMITS.messageLength / 2) {
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
      continue;
    }
    const code = rest.charCodeAt(LIMITS.messageLength - 1);
    const at = code >= 0xd800 && code <= 0xdbff ? LIMITS.messageLength - 1 : LIMITS.messageLength;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return [...out, rest];
}
