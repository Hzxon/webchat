// The user's conversations with their coding agents, as the Coding agents pane shows them (R-035,
// D-102, D-103). A conversation is a prompt and the messages whose `prompt` field names the
// prompt's client id, all in the user's direct chat with the agent.
import { useMemo } from 'react';
import { AGENT_LEVEL, type AgentRepoDTO, type RunDTO, type UserDTO } from '../../shared/types';
import type { Tone } from './components/PullTags';
import type { ChatConversation, ChatMessage } from './e2ee/keyring';
import { otherMemberId, useAppState, type State } from './store';

/** The agent ends a conversation left this long, and a turn never runs this long (D-102). */
export const THREAD_TTL_MS = 24 * 60 * 60_000;

export interface Thread {
  /** A question, or a card the owner handed the agent from its brief (D-105). */
  kind: 'question' | 'card';
  /** The prompt's or the run request's client id. */
  root: string;
  /** For a card: its request's message id, which the agent's reports name. */
  request?: number;
  conversationId: number;
  repo: string;
  /** The prompt first, then the messages that name it, in the chat's order, one per answer. */
  messages: ChatMessage[];
  state: 'working' | 'answered' | 'failed' | 'unsent' | 'ended' | 'draft' | 'waiting' | 'unfinished' | 'done';
  /** When its newest message was sent. */
  last: number;
  /** The cards its drafts became on the board, by the draft's client id (D-104). */
  added: Record<string, string>;
}

/** A conversation's state, in words, wherever the page names it. */
export const THREAD_STATE: Record<Thread['state'], { label: string; tone: Tone }> = {
  working: { label: 'Working…', tone: 'info' },
  answered: { label: 'Answered', tone: 'ok' },
  failed: { label: 'Couldn’t answer', tone: 'danger' },
  unsent: { label: 'Not sent', tone: 'danger' },
  ended: { label: 'Ended', tone: 'muted' },
  draft: { label: 'Draft ready', tone: 'ok' },
  waiting: { label: 'Waiting for you', tone: 'warn' },
  unfinished: { label: 'Couldn’t finish', tone: 'danger' },
  done: { label: 'Done', tone: 'muted' },
};

/** What each run message makes of its card's conversation; a cancel changes nothing until the agent says it stopped. */
const RUN_STATE: Partial<Record<RunDTO['kind'], Thread['state']>> = {
  claimed: 'working',
  fixing: 'working',
  fix: 'working',
  done: 'draft',
  review: 'waiting',
  failed: 'unfinished',
  ended: 'done',
};

/** A Claude Code session of the user's agent, by the repository it is open in (D-094). */
export interface Seat extends AgentRepoDTO {
  agent: UserDTO;
}

/** A repository by its name alone, as students know it: "capstone-app" for "team/capstone-app". */
export const short = (repo: string) => repo.slice(repo.indexOf('/') + 1);

/** The user's own coding agents (D-089). */
export const ownAgents = (users: State['users'], meId: number | undefined) => Object.values(users).filter((u) => u.agentOwner === meId && !u.deleted);

/** A session that takes a question now: online, on a plugin that answers questions (D-103). */
export const ready = (seat: AgentRepoDTO) => seat.online && seat.protocol >= AGENT_LEVEL.answers;

/** The agent a chat is the user's direct chat with, when the agent is theirs (D-089). */
export function agentOf(state: Pick<State, 'users' | 'me'>, conversation: ChatConversation): UserDTO | undefined {
  const otherId = otherMemberId(conversation, state.me?.id);
  const other = otherId === undefined ? undefined : state.users[otherId];
  return other && other.agentOwner === state.me?.id && !other.deleted ? other : undefined;
}

export const agentChats = (state: Pick<State, 'users' | 'me' | 'conversations'>) => Object.values(state.conversations).filter((c) => agentOf(state, c));

/**
 * A chat's conversations, newest first. Only the user's prompts start one, and only the user's and
 * the agent's signed messages count, as the agent heeds only its owner (D-089). An answer longer
 * than a message comes as several, which this joins into one (D-102). A prompt or reply that did not
 * send is no turn the agent works on: the conversation is Not sent until it is sent again.
 */
export function threadsOf(messages: ChatMessage[], meId: number, agentId: number, pending: State['pending'] = {}, now = Date.now()): Thread[] {
  const threads = new Map<string, Thread>();
  // A card's thread by its request's message id, which the reports name.
  const requests = new Map<number, Thread>();
  for (const message of messages) {
    const prompt = message.prompt;
    if (message.security !== 'encrypted') continue;
    if (message.added && message.senderId === meId) {
      const thread = threads.get(message.added.to);
      if (thread) thread.added[message.added.draft] = message.added.card;
      continue;
    }
    const run = message.run;
    if (run?.kind === 'request') {
      if (message.senderId === meId && message.clientId) {
        const state = pending[message.clientId] === 'failed' ? 'unsent' : 'working';
        const thread: Thread = { kind: 'card', root: message.clientId, request: message.id, conversationId: message.conversationId, repo: run.repo ?? '', messages: [message], state, last: message.createdAt, added: {} };
        threads.set(message.clientId, thread);
        requests.set(message.id, thread);
      }
      continue;
    }
    if (run) {
      const thread = requests.get(run.request);
      const fromMe = run.kind === 'cancel' || run.kind === 'fix';
      if (!thread || message.senderId !== (fromMe ? meId : agentId)) continue;
      thread.messages.push(message);
      thread.last = Math.max(thread.last, message.createdAt);
      thread.state = RUN_STATE[run.kind] ?? thread.state;
      continue;
    }
    if (!prompt) continue;
    if (prompt.kind === 'prompt') {
      if (message.senderId === meId && message.clientId) {
        const state = pending[message.clientId] === 'failed' ? 'unsent' : 'working';
        threads.set(message.clientId, { kind: 'question', root: message.clientId, conversationId: message.conversationId, repo: prompt.repo, messages: [message], state, last: message.createdAt, added: {} });
      }
      continue;
    }
    const thread = threads.get(prompt.to);
    const fromMe = prompt.kind === 'reply' || prompt.kind === 'cancel';
    if (!thread || message.senderId !== (fromMe ? meId : agentId)) continue;
    const previous = thread.messages.at(-1)!;
    // A card draft stays a message of its own (D-104).
    const part = (m: ChatMessage) => m.prompt?.kind === 'answer' && !m.prompt.card;
    if (part(message) && part(previous)) thread.messages[thread.messages.length - 1] = { ...previous, text: previous.text + message.text };
    else thread.messages.push(message);
    thread.last = Math.max(thread.last, message.createdAt);
    // A cancel changes nothing until the agent says it stopped.
    if (prompt.kind === 'reply') thread.state = pending[message.clientId ?? ''] === 'failed' ? 'unsent' : 'working';
    else if (prompt.kind === 'answer') thread.state = 'answered';
    else if (prompt.kind === 'failed') thread.state = 'failed';
  }
  // A card's conversation lasts as long as its draft is watched, so only a question ends.
  return [...threads.values()].map((t) => (t.kind === 'question' && now - t.last > THREAD_TTL_MS ? { ...t, state: 'ended' as const } : t)).sort((a, b) => b.last - a.last);
}

/** The user's chats with their agents, and every conversation in them, newest first. */
export function useAgentThreads() {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const me = useAppState((s) => s.me);
  const messages = useAppState((s) => s.messages);
  const pending = useAppState((s) => s.pending);
  return useMemo(() => {
    const chats = agentChats({ users, me, conversations });
    const threads = me ? chats.flatMap((chat) => threadsOf(messages[chat.id] ?? [], me.id, agentOf({ users, me }, chat)!.id, pending)) : [];
    return { chats, threads: threads.sort((a, b) => b.last - a.last) };
  }, [users, me, conversations, messages, pending]);
}
