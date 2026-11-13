// The user's conversations with their coding agents, as the Coding agents pane shows them (R-035,
// D-102, D-103). A conversation is a prompt and the messages whose `prompt` field names the
// prompt's client id, all in the user's direct chat with the agent.
import { useMemo } from 'react';
import { AGENT_LEVEL, ASK_WAIT_MS, takesSetup, type AgentRepoDTO, type PermitDTO, type RunDTO, type UserDTO } from '../../shared/types';
import { formatSince } from './components/format';
import type { Tone } from './components/PullTags';
import type { ChatConversation, ChatMessage } from './e2ee/keyring';
import { otherMemberId, useAppState, type State } from './store';

/** The agent ends a conversation left this long, and a turn never runs this long (D-102). */
export const THREAD_TTL_MS = 24 * 60 * 60_000;

export interface Thread {
  /** A question, a card the owner handed the agent from its brief (D-105), or a proposal merged in a linked repository (R-040). */
  kind: 'question' | 'card' | 'proposal';
  /** The prompt's or the run request's client id. */
  root: string;
  /** For a card: its request's message id, which the agent's reports name. */
  request?: number;
  conversationId: number;
  /** The repository it is about, or '' for a question about its project's board alone (R-038). */
  repo: string;
  /** The harness its request named, or none for the laptop's host. */
  harness?: string;
  /** For a question: the project its prompt names, whose board the agent reads (D-104, R-038); for a proposal, its board's. */
  project?: number;
  /** The prompt first, then the messages that name it, in the chat's order, one per answer. */
  messages: ChatMessage[];
  state: 'working' | 'answered' | 'failed' | 'unsent' | 'ended' | 'draft' | 'waiting' | 'unfinished' | 'done' | 'stale' | 'paused' | 'planned' | 'asking';
  /** When its newest message was sent. */
  last: number;
  /** For a card that is being worked on: what the run does now, from its newest progress report (docs/decisions/stop-pauses-run.md). */
  progress?: string;
  /** While `asking`: the agent's question, and whether the owner's answer is sent, which waits for the agent's word (docs/decisions/harness-approvals.md). */
  ask?: { message: ChatMessage & { permit: Extract<PermitDTO, { kind: 'question' }> }; answered: boolean };
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
  stale: { label: 'No longer holds', tone: 'warn' },
  paused: { label: 'Stopped', tone: 'warn' },
  planned: { label: 'Plan ready', tone: 'warn' },
  asking: { label: 'Asking you', tone: 'warn' },
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
  nocopy: 'waiting',
  clone: 'working',
  stale: 'stale',
  decision: 'waiting',
  merged: 'done',
  closed: 'done',
  paused: 'paused',
  planned: 'planned',
};

/** Where the user's agent works on a repository: its folder on the laptop (D-094), or none there yet (R-036). */
export interface Seat extends AgentRepoDTO {
  agent: UserDTO;
  /** The laptop has no folder of it, and the agent asks to clone it first. */
  noFolder?: boolean;
}

/**
 * Where an agent would work on a repository: the folder its check-ins name, or on a laptop that
 * serves every folder, the laptop itself, which offers a clone (R-036). None on an older plugin
 * with no session in it. GitHub ignores case in names.
 */
export function seatFor(agent: UserDTO, repo: string): Seat | undefined {
  const seat = agent.agentRepos.find((s) => s.repo.toLowerCase() === repo.toLowerCase());
  if (seat?.online || !agent.protocol) return seat && { ...seat, agent };
  return { repo, online: agent.online, lastSeen: agent.lastSeen ?? 0, protocol: agent.protocol, agent, noFolder: !seat || agent.online };
}

const UPDATE = 'Your agent is too old for this. Run webchat-agent setup in a terminal on your laptop to update it.';

/** What wakes the agent: one service serves every folder on the laptop (R-036). */
export const WAKE = 'Your laptop must be awake and logged in, with the webchat-agent services running. If you put your agent to sleep, run webchat-agent wake in a terminal there.';

export const asleep = (lastSeen: number | null) => `Your agent is asleep${lastSeen ? ` since ${formatSince(lastSeen)}` : ''}`;

/** Why a question or reply, or with `setup` a change of settings, cannot go to the agent now, in plain words, or '' when it can. */
export function blockedBy(seat: { protocol: number; online: boolean; lastSeen: number | null } | undefined, setup = false) {
  // An older plugin checks in per repository and answers nothing else, nor heeds `setup` (D-103, R-036, D-115).
  if (!seat || seat.protocol < AGENT_LEVEL.answers || (setup && !takesSetup(seat.protocol))) return UPDATE;
  if (!seat.online) return `${asleep(seat.lastSeen)}. ${WAKE}`;
  return '';
}

/** A repository by its name alone, as students know it: "capstone-app" for "team/capstone-app". */
export const short = (repo: string) => repo.slice(repo.indexOf('/') + 1);

/** The user's own coding agents (D-089). */
export const ownAgents = (users: State['users'], meId: number | undefined) => Object.values(users).filter((u) => u.agentOwner === meId && !u.deleted);

/** A session that takes a question now: online, on an agent that answers questions (D-103). */
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
  // A card's thread by its request's message id, which the reports name, and those with a draft.
  const requests = new Map<number, Thread>();
  const drafted = new Set<Thread>();
  // The threads that asked, by the question's client id, which the owner's answer and the agent's `settled` name.
  const asked = new Map<string, Thread>();
  for (const message of messages) {
    const prompt = message.prompt;
    if (message.security !== 'encrypted') continue;
    const permit = message.permit;
    if (permit) {
      if (permit.kind === 'question') {
        const thread = permit.request !== undefined ? requests.get(permit.request) : threads.get(permit.to ?? '');
        // Only the thread's own agent asks, and the id is what the answer names.
        if (!thread || message.senderId !== agentId || !message.clientId) continue;
        asked.set(message.clientId, thread);
        thread.messages.push(message);
        thread.ask = { message: message as ChatMessage & { permit: typeof permit }, answered: false };
        thread.state = 'asking';
        thread.last = Math.max(thread.last, message.createdAt);
        delete thread.progress;
        continue;
      }
      const thread = asked.get(permit.to);
      if (!thread?.ask || thread.ask.message.clientId !== permit.to) continue;
      if (permit.kind === 'answer' && message.senderId === meId) thread.ask.answered = pending[message.clientId ?? ''] !== 'failed';
      // A stale answer leaves the question open, and the buttons show again.
      else if (permit.kind === 'settled' && message.senderId === agentId) {
        if (permit.outcome === 'stale') thread.ask.answered = false;
        else if (thread.state === 'asking') thread.state = 'working';
      }
      continue;
    }
    if (message.added && message.senderId === meId) {
      const thread = threads.get(message.added.to);
      if (thread) thread.added[message.added.draft] = message.added.card;
      if (thread?.kind === 'proposal') thread.state = 'done';
      continue;
    }
    // A proposal file the default branch of a linked repository gained, which the agent hands its owner as a draft (R-040).
    if (message.board?.kind === 'proposal') {
      const { project, repo } = message.board;
      if (message.senderId === agentId && message.clientId) {
        threads.set(message.clientId, { kind: 'proposal', root: message.clientId, conversationId: message.conversationId, repo, project, messages: [message], state: 'draft', last: message.createdAt, added: {} });
      }
      continue;
    }
    const run = message.run;
    if (run?.kind === 'request') {
      if (message.senderId === meId && message.clientId) {
        const state = pending[message.clientId] === 'failed' ? 'unsent' : 'working';
        const thread: Thread = { kind: 'card', root: message.clientId, request: message.id, conversationId: message.conversationId, repo: run.repo ?? '', harness: run.harness, messages: [message], state, last: message.createdAt, added: {} };
        threads.set(message.clientId, thread);
        requests.set(message.id, thread);
      }
      continue;
    }
    if (run) {
      const thread = requests.get(run.request);
      const fromMe = run.kind === 'cancel' || run.kind === 'fix' || run.kind === 'clone';
      if (!thread || message.senderId !== (fromMe ? meId : agentId)) continue;
      thread.last = Math.max(thread.last, message.createdAt);
      // A progress line is a note on the state, shown under Working…, not a message of its own; the next message ends it.
      if (run.kind === 'progress') {
        thread.progress = run.note;
        continue;
      }
      delete thread.progress;
      thread.messages.push(message);
      if (run.kind === 'done') drafted.add(thread);
      let state = RUN_STATE[run.kind];
      // A round that failed leaves the draft it worked on; a go that did not send is no round.
      if (run.kind === 'failed' && drafted.has(thread)) state = 'draft';
      if (fromMe && pending[message.clientId ?? ''] === 'failed') state = 'unsent';
      thread.state = state ?? thread.state;
      continue;
    }
    if (!prompt) continue;
    if (prompt.kind === 'prompt') {
      if (message.senderId === meId && message.clientId) {
        const state = pending[message.clientId] === 'failed' ? 'unsent' : 'working';
        threads.set(message.clientId, { kind: 'question', root: message.clientId, conversationId: message.conversationId, repo: prompt.repo ?? '', harness: prompt.harness, project: prompt.project, messages: [message], state, last: message.createdAt, added: {} });
      }
      continue;
    }
    const thread = threads.get(prompt.to);
    const fromMe = prompt.kind === 'reply' || prompt.kind === 'cancel' || prompt.kind === 'clone';
    if (!thread || message.senderId !== (fromMe ? meId : agentId)) continue;
    const previous = thread.messages.at(-1)!;
    // A card draft stays a message of its own (D-104).
    const part = (m: ChatMessage) => m.prompt?.kind === 'answer' && !m.prompt.card;
    if (part(message) && part(previous)) thread.messages[thread.messages.length - 1] = { ...previous, text: previous.text + message.text };
    else thread.messages.push(message);
    thread.last = Math.max(thread.last, message.createdAt);
    // A cancel changes nothing until the agent says it stopped.
    if (prompt.kind === 'reply' || prompt.kind === 'clone') thread.state = pending[message.clientId ?? ''] === 'failed' ? 'unsent' : 'working';
    else if (prompt.kind === 'answer') thread.state = 'answered';
    else if (prompt.kind === 'failed') thread.state = 'failed';
    // The laptop has no copy of the repository, and the turn waits for the owner (R-036).
    else if (prompt.kind === 'nocopy') thread.state = 'waiting';
  }
  // A card's conversation lasts as long as its draft is watched, so only a question ends, and one that asks waits as long as the agent does.
  for (const t of threads.values()) if (t.state !== 'asking') delete t.ask;
  return [...threads.values()].map((t) => (t.kind === 'question' && now - t.last > (t.state === 'asking' ? ASK_WAIT_MS : THREAD_TTL_MS) ? { ...t, state: 'ended' as const } : t)).sort((a, b) => b.last - a.last);
}

/** Where a conversation belongs: the project its prompt names, a proposal's board's, or a card's board's. */
export function threadProject(thread: Thread, docs: State['docs'], conversations: State['conversations']) {
  const run = thread.messages[0]!.run;
  if (thread.kind !== 'card') return thread.project;
  return run?.kind === 'request' ? conversations[docs[run.docId]?.conversationId ?? 0]?.projectId : undefined;
}

/** The proposals for a board and its linked repository whose draft the owner has not added yet, newest first (D-117, K-72). */
export const waitingProposals = (threads: Thread[], projectId: number, repo: string) =>
  threads.filter((t) => t.kind === 'proposal' && t.state === 'draft' && t.project === projectId && t.repo.toLowerCase() === repo.toLowerCase());

/** The user's chats with their agents. */
/** The user's direct chat with one of their agents, where its sealed setup answers come (R-039). */
export function useAgentChat(agent: UserDTO | undefined) {
  return useAgentChats().find((c) => agent && c.members.some((m) => m.userId === agent.id));
}

export function useAgentChats() {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const me = useAppState((s) => s.me);
  return useMemo(() => agentChats({ users, me, conversations }), [users, me, conversations]);
}

/** The user's chats with their agents, and every conversation in them, newest first. */
export function useAgentThreads() {
  const chats = useAgentChats();
  const users = useAppState((s) => s.users);
  const me = useAppState((s) => s.me);
  const messages = useAppState((s) => s.messages);
  const pending = useAppState((s) => s.pending);
  return useMemo(() => {
    const threads = me ? chats.flatMap((chat) => threadsOf(messages[chat.id] ?? [], me.id, agentOf({ users, me }, chat)!.id, pending)) : [];
    return { chats, threads: threads.sort((a, b) => b.last - a.last) };
  }, [chats, users, me, messages, pending]);
}

/** Every run message, and every claim of open pull requests (R-040), in the user's chats with their agents, as one string that changes when one moves. */
export const runSignature = (state: State) =>
  agentChats(state)
    .flatMap((c) => (state.messages[c.id] ?? []).filter((m) => m.run || m.board?.kind === 'claims').map((m) => `${m.id}:${m.run?.kind ?? 'claims'}`))
    .join();

export const seatKey = (seat: Seat) => `${seat.agent.id}:${seat.repo}`;

/** Messages of several chats in the order they were sent: by id, then those still sending, as the store keeps them. */
export const inOrder = (messages: ChatMessage[]) => [...messages.filter((m) => m.id > 0).sort((a, b) => a.id - b.id), ...messages.filter((m) => m.id < 0)];
