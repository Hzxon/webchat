import { keyFingerprint, openPicks, pairingId, pairingProof, permitHash } from '../../../shared/e2ee';
import { LIMITS, type CardNoteDTO, type PullCardDTO, type PullRequestDTO, type AskDTO, type CardAskDTO, type PromptDTO, type PermitDTO, type PairingPick, type PermissionMode, type PublicKeysDTO, type RunDTO, type RunRequest, type SetupChoice, type UserDTO } from '../../../shared/types';
import { api } from '../api';
import { keyring, type ChatMessage } from '../e2ee/keyring';
import type { Card } from '../../../shared/board';
import { ownAgents } from '../agents';
import { actions, senderName, store } from '../store';
import { checkKeys, currentLookup, meId, newClientId, reloadAll, sendContent, startDirectChat, syncNow } from './core';
import { addProjectMembers } from './members';

/**
 * Hands a board card to the user's coding agent (R-027, D-089, D-105): a message in their direct
 * chat with it whose `run` field names the card, the agent's account, the repository whose Claude
 * Code session runs it (D-094), when it was sent, and the hash of the brief the owner saw. The agent
 * answers with reports that name this message, which the pane and the board fold into the card. The
 * text says the same in words. Returns the conversation, by the request's client id.
 */
export async function requestRun(docId: string, card: Card, runtime: UserDTO, repo: string, hash: string, harness?: string) {
  const conversationId = await startDirectChat(runtime.id);
  const id = `${card.kind}-${card.number}`;
  const run: RunRequest = { kind: 'request', card: id, title: card.title.slice(0, LIMITS.runNoteLength), docId, section: card.id, runtime: runtime.id, sentAt: Date.now(), repo, hash, was: card.status, asks: true, ...(harness && { harness }) };
  const clientId = newClientId();
  void sendContent(conversationId, { text: `Run ${id}: ${card.title}`, run }, false, clientId);
  return clientId;
}

/** The owner's go for another round on a run's draft, after a review or with their own words (D-105). */
export function askFix(conversationId: number, request: number, note: string, review?: number) {
  const fix: RunDTO = { kind: 'fix', request, sentAt: Date.now() };
  if (note.trim()) fix.note = note.trim();
  // The review it approves, so only the text the owner saw runs (D-105).
  if (review !== undefined) fix.review = review;
  // With neither words nor a review it is the go on a plan (docs/decisions/redirect-plan-gate.md).
  return sendContent(conversationId, { text: note.trim() || (review === undefined ? 'Go.' : 'Let the agent fix it.'), run: fix }, false);
}

/**
 * Has the user's agent clone a repository its laptop has no copy of, for the run or conversation
 * that waits on it (R-036, D-108). Signed like a prompt, so only its owner's click clones.
 */
export function askClone(conversationId: number, repo: string, waiting: { request: number } | { to: string }) {
  const sentAt = Date.now();
  const asked = 'request' in waiting ? { run: { kind: 'clone' as const, request: waiting.request, repo, sentAt } } : { prompt: { kind: 'clone' as const, to: waiting.to, repo, sentAt } };
  return sendContent(conversationId, { text: `Clone ${repo}`, ...asked }, false);
}

/**
 * Asks one of the user's coding agents (D-102, R-038): a message in their direct chat with it, whose
 * `prompt` field names the project, whose board alone goes in the brief (D-104), or none for a chat
 * outside every project; one repository, or none for a project that links none; and the harness picked, or none
 * for the laptop's host harness. `own` says the user typed it, so it may run in their own setup
 * (D-157); `card` asks for one draft from the new card form (R-071); `resume` goes on with a
 * terminal's session (R-072), with the model and permission mode the ask box picked. The agent's laptop answers. Returns the conversation, by the prompt's client id.
 */
export async function askAgent(agentId: number, project: number | undefined, repo: string | undefined, question: string, { harness, own, card, resume, model, mode }: { harness?: string; own?: true; card?: CardAskDTO; resume?: string; model?: string; mode?: PermissionMode } = {}) {
  const conversationId = await startDirectChat(agentId);
  const clientId = newClientId();
  // The message shows as sending at once, so the pane can open its conversation.
  void sendContent(conversationId, { text: question.trim(), prompt: { kind: 'prompt', sentAt: Date.now(), asks: true, events: true, ...(project && { project }), ...(repo && { repo }), ...(harness && { harness }), ...(own && { own }), ...(card && { card }), ...(resume && { resume }), ...(model && { model }), ...(mode && { mode }) } }, false, clientId);
  return clientId;
}

/**
 * Answers an agent's question before an action (docs/decisions/harness-approvals.md): the question
 * is named by its client id, and the answer signs the time and a hash of what the owner saw.
 */
export async function answerPermit(conversationId: number, question: ChatMessage & { permit: Extract<PermitDTO, { kind: 'question' }> }, decision: 'once' | 'run' | 'deny') {
  const permit: PermitDTO = { kind: 'answer', to: question.clientId!, decision, seen: await permitHash(question.permit), sentAt: Date.now() };
  const text = { once: 'Allow it', run: 'Allow it for this run', deny: 'Deny it' }[decision];
  return sendContent(conversationId, { text, permit }, false);
}

/** Puts the user's agent to sleep after what it runs; only `webchat-agent wake` on the laptop wakes it (K-66, D-113). */
export async function putToSleep(agentId: number) {
  await sendContent(await startDirectChat(agentId), { text: 'Go to sleep', sleep: { sentAt: Date.now() } }, false);
}

/**
 * Asks the user's agent what its runs load from their Claude setup, and with a choice, changes it
 * (R-039, D-115). Returns the ask's client id, which the agent's answer names.
 */
export async function askSetup(agentId: number, choice?: SetupChoice) {
  const conversationId = await startDirectChat(agentId);
  const clientId = newClientId();
  const text = choice ? 'Change what your runs load from my Claude setup' : 'What do your runs load from my Claude setup?';
  void sendContent(conversationId, { text, setup: { sentAt: Date.now(), ...(choice && { choice }) } }, false, clientId);
  return clientId;
}

/** Asks the user's agent for the sessions their terminal started in a connected folder; returns the ask's client id, which the list names (R-072). */
export async function askSessions(agentId: number, repo: string) {
  const conversationId = await startDirectChat(agentId);
  const clientId = newClientId();
  void sendContent(conversationId, { text: `Sessions from my terminal in ${repo}`, sessions: { repo, sentAt: Date.now() } }, false, clientId);
  return clientId;
}

/** Answers an agent's request, which names it by its client id (docs/decisions/harness-linking.md, docs/decisions/connect-approval.md). A connect's approval signs the repository and folder shown. */
export function answerAsk(conversationId: number, to: string, request: Extract<AskDTO, { step: 'request' }>, step: 'approve' | 'decline') {
  const sentAt = Date.now();
  const ask: AskDTO = step === 'decline' ? { kind: request.kind, step, to, sentAt } : request.kind === 'link' ? { kind: 'link', step, to, sentAt } : { kind: 'connect', step, to, sentAt, repo: request.repo, folder: request.folder };
  return sendContent(conversationId, { text: step === 'approve' ? 'Approve it' : 'Decline it', ask }, false);
}

/** Asks the user's agent for a repository's entries, to link the board to it (R-040). Returns the ask's client id, which its answers name. */
export async function askLink(agentId: number, project: number, repo: string) {
  const conversationId = await startDirectChat(agentId);
  const clientId = newClientId();
  void sendContent(conversationId, { text: `Link the board to ${repo}`, board: { kind: 'link', project, repo, sentAt: Date.now() } }, false, clientId);
  return clientId;
}

/** Has the user's agent forget its folder of a repository: the mark goes, never the files (R-038, D-101). */
export async function forgetFolder(agentId: number, repo: string) {
  await sendContent(await startDirectChat(agentId), { text: `Forget the folder of ${repo}`, forget: { repo, sentAt: Date.now() } }, false);
}

/** Replies in a conversation with an agent, or stops its turn. Both name the prompt's client id (D-102). */
export function tellAgent(conversationId: number, to: string, kind: 'reply' | 'cancel', text: string, extra: ReplyExtra = {}) {
  // A reply from the new card form carries its fields as they stand, so the draft builds on the user's edits (R-071);
  // one from the session's controls, a model, a mode or a hand over (R-072, D-156).
  const prompt: PromptDTO = kind === 'reply' ? { kind, to, sentAt: Date.now(), ...extra } : { kind, to, sentAt: Date.now() };
  return sendContent(conversationId, { text: text.trim(), prompt }, false);
}

/** What a reply may carry besides the words (R-071, R-072, D-156). */
export type ReplyExtra = Partial<Pick<Extract<PromptDTO, { kind: 'reply' }>, 'card' | 'model' | 'mode' | 'handover'>>;

/** Tells the user's other devices that their page put an agent's card draft on the board (D-104). The agent ignores it. */
export function noteAdded(conversationId: number, to: string, draft: string, card: string) {
  return sendContent(conversationId, { text: `Added ${card} to the board.`, added: { to, draft, card } }, false);
}

/** Tells the user's devices that they dismissed a proposal's draft, which then waits no longer (R-047). The agent ignores it. */
export function noteDismissed(conversationId: number, to: string, title: string) {
  return sendContent(conversationId, { text: `Dismissed the proposal ${title}.`, dismissed: { to } }, false);
}

/**
 * Asks a member about a board card in the direct chat with them, so they alone get a push, an
 * ordinary message's (the card-notes decision).
 */
export function sendCardNote(conversationId: number, card: CardNoteDTO, text: string) {
  return sendContent(conversationId, { text, card }, false);
}

/** Stops a run the user handed to an agent (R-030). The agent heeds only the person who sent the request. */
export function cancelRun(request: ChatMessage & { run: RunRequest }) {
  const text = `Cancel ${request.run.card} with ${senderName(store.get().users, request.run.runtime)}`;
  return sendContent(request.conversationId, { text, run: { kind: 'cancel', request: request.id } }, false);
}

/** Removes one of the user's agents for good (R-033). Its chats get new keys, as when anyone leaves. */
export async function removeAgent(agent: UserDTO) {
  await api.removeAgent(agent.id);
  void syncNow();
}

/**
 * The coding agent's half of a pairing, once it sent one: its keys, which the code proves (R-030,
 * D-093), and the harnesses it asks to link, which the code opens. Null while it has sent none. The
 * code stays in this page: the server sees only a hash of it.
 */
export async function pairingKeys(code: string): Promise<{ keys: PublicKeysDTO; picks: PairingPick[] } | null> {
  const pairing = await api.pairing(await pairingId(code));
  if (!pairing) return null;
  if (pairing.proof !== (await pairingProof(code, pairing.keys))) throw new Error('These keys did not come with the code. Close this window and make a new code.');
  return { keys: pairing.keys, picks: pairing.picks ? await openPicks(code, pairing.keys, pairing.picks) : [] };
}

/**
 * Approves a pairing: the server makes the agent's account, this browser pins the keys the code
 * proved, and the agent joins the projects picked, with their channel keys. The agent pins this
 * user's keys from the proof sent along (D-093).
 */
export async function connectAgent(code: string, keys: PublicKeysDTO, displayName: string, projectIds: number[]) {
  const proof = await pairingProof(code, keys, { id: meId, keys: keyring.myKeys() });
  const agent = await api.approvePairing(await pairingId(code), { displayName, proof });
  if (agent.keys?.dh !== keys.dh || agent.keys.sign !== keys.sign) throw new Error('The server made the agent’s account with other keys.');
  // Pinned before the first check-in sees the account, so keys the server swaps in later show as changed (D-018).
  await keyring.trust(agent);
  await reloadAll();
  for (const projectId of projectIds) await addProjectMembers(projectId, [agent.id]);
  // The agent never makes a chat key, so it needs this chat to send a request into (docs/decisions/connect-approval.md).
  await startDirectChat(agent.id).catch(() => undefined);
  return agent;
}

/**
 * Sends a pull request into a chat as a card. The text says the same in words, so an older page,
 * a notification and the chat list have something to show. The server sees an ordinary message.
 */
export function sharePull(conversationId: number, pull: PullRequestDTO) {
  const card: PullCardDTO = {
    repo: pull.repo,
    number: pull.number,
    title: pull.title,
    url: pull.url,
    draft: pull.draft,
    review: pull.review,
    checks: pull.checks,
    conflicts: pull.conflicts,
  };
  if (pull.reviewers) card.reviewers = pull.reviewers.slice(0, LIMITS.pullPeople);
  if (pull.assignees) card.assignees = pull.assignees.slice(0, LIMITS.pullPeople);
  const lines = [`Pull request ${card.repo}#${card.number}: ${card.title}`];
  if (card.reviewers?.length) lines.push(`Reviewers: ${card.reviewers.map((name) => `@${name}`).join(', ')}`);
  lines.push(card.url);
  return sendContent(conversationId, { text: lines.join('\n'), pull: card }, false);
}

/** Accepts a person's changed keys after the user compared security codes with them. */
/** Marks a person verified after the user compared the security code, and trusts their keys. */
export async function verifyKeys(user: UserDTO) {
  await keyring.verify(user);
  await trustKeys(user);
}

export async function trustKeys(user: UserDTO) {
  await keyring.trust(user);
  await checkKeys(Object.values(store.get().users));
  // What failed under the unchecked keys opens now, without a reload. It never alerts again.
  for (const message of await keyring.reopen(store.get().conversations, currentLookup())) actions.addMessage(message, false);
  // The user's agents pin the same keys, or a card's brief would hash differently there (K-57, D-110).
  if (!user.keys) return;
  const trust = { user: user.id, fingerprint: await keyFingerprint(user.keys), sentAt: Date.now() };
  for (const agent of ownAgents(store.get().users, meId)) {
    await sendContent(await startDirectChat(agent.id), { text: `I checked ${user.displayName}’s security code.`, trust }, false);
  }
}
