// The user's conversations with their coding agents, as the Coding agents pane shows them (R-035,
// D-102, D-103). A conversation is a prompt and the messages whose `prompt` field names the
// prompt's client id, all in the user's direct chat with the agent.
import { useMemo } from 'react';
import { AGENT_LEVEL, type AgentRepoDTO, type UserDTO } from '../../shared/types';
import type { Tone } from './components/PullTags';
import type { ChatConversation, ChatMessage } from './e2ee/keyring';
import { otherMemberId, useAppState, type State } from './store';

/** The agent ends a conversation left this long, and a turn never runs this long (D-102). */
export const THREAD_TTL_MS = 24 * 60 * 60_000;

export interface Thread {
  /** The prompt's client id, which every later message names. */
  root: string;
  conversationId: number;
  repo: string;
  /** The prompt first, then the messages that name it, in the chat's order, one per answer. */
  messages: ChatMessage[];
  state: 'working' | 'answered' | 'failed' | 'unsent' | 'ended';
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
};

/** A Claude Code session of the user's agent, by the repository it is open in (D-094). */
export interface Seat extends AgentRepoDTO {
  agent: UserDTO;
}

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
  for (const message of messages) {
    const prompt = message.prompt;
    if (message.security !== 'encrypted') continue;
    if (message.added && message.senderId === meId) {
      const thread = threads.get(message.added.to);
      if (thread) thread.added[message.added.draft] = message.added.card;
      continue;
    }
    if (!prompt) continue;
    if (prompt.kind === 'prompt') {
      if (message.senderId === meId && message.clientId) {
        const state = pending[message.clientId] === 'failed' ? 'unsent' : 'working';
        threads.set(message.clientId, { root: message.clientId, conversationId: message.conversationId, repo: prompt.repo, messages: [message], state, last: message.createdAt, added: {} });
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
  return [...threads.values()].map((t) => (now - t.last > THREAD_TTL_MS ? { ...t, state: 'ended' as const } : t)).sort((a, b) => b.last - a.last);
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
