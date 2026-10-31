// Keeps the page in step with the server and decides how each incoming message alerts the user.
//
// There is no open connection: the server runs as short-lived serverless functions. Instead the
// page checks in with POST /api/sync. A push from the service worker makes it check in at once;
// otherwise it checks in on a timer that is faster when the user is looking and push is off.
//
// Everything the server sends is decrypted on the way in, and every message is encrypted on the
// way out (see e2ee/keyring.ts). The store only ever holds readable text.
import type { QuotedMessage } from '../../shared/e2ee';
import { LIMITS, type ConversationDTO, type SyncResponse, type UserDTO, type WorkerToPageMessage } from '../../shared/types';
import { showUnreadInTab, sound } from './alerts';
import { announceAccountChange, api, ApiError, sendAwayBeacon, setTabUser } from './api';
import { attention } from './attention';
import { EncryptionUnavailableError, keyring, type ChatConversation, type ChatMessage, type KeyLookup } from './e2ee/keyring';
import { forgetPushOnServer, getPushState, showLocalNotification, syncPushSubscription } from './push';
import { actions, chatTitle, store } from './store';

const newClientId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const tabId = newClientId();
let running = false;
let meId = 0;
let cursor = 0;
let stamp = '';
let pushActiveHere = false;
let pushEndpoint: string | null = null;
/** Messages already handled, so the overlap that sync re-sends never alerts twice. */
const seen = new Set<number>();
let onSignedOut: () => void = () => undefined;
const cleanups: Array<() => void> = [];
// Bumped on every start, so an older start that is still loading knows to stop.
let generation = 0;

/** Public keys by person: the unlocked keys for oneself, the given server list for everyone else. */
function lookupFrom(users: UserDTO[]): KeyLookup {
  const byId = new Map(users.map((u) => [u.id, u.keys]));
  return (userId) => (userId === meId ? keyring.myKeys() : (byId.get(userId) ?? null));
}

const currentLookup = () => lookupFrom(Object.values(store.get().users));

const openConversations = (list: ConversationDTO[], keysOf: KeyLookup): Promise<ChatConversation[]> =>
  Promise.all(list.map(async (c) => ({ ...c, lastMessage: c.lastMessage ? await keyring.open(c.lastMessage, c, keysOf) : null })));

/** How long to wait before the next check-in. */
function syncInterval(): number {
  if (attention.isAttentive()) return pushActiveHere ? 15_000 : 3_000;
  return pushActiveHere ? 60_000 : 10_000;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let again = false;
let failures = 0;

function schedule(delay: number) {
  clearTimeout(timer);
  if (running) timer = setTimeout(() => void syncNow(), delay);
}

/** Checks in with the server now. Calls made while one is running collapse into one more. */
export async function syncNow(): Promise<void> {
  if (!running) return;
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  clearTimeout(timer);
  try {
    const result = await api.sync({ cursor, stamp, attentive: attention.isAttentive(), tabId, endpoint: pushEndpoint });
    failures = 0;
    actions.setConnected(true);
    if (result.changed) await applyChanges(result);
    stamp = result.stamp;
    cursor = Math.max(cursor, result.cursor);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      void endSession();
      return;
    }
    failures++;
    actions.setConnected(false);
  } finally {
    inFlight = false;
    if (again) {
      again = false;
      void syncNow();
    } else {
      schedule(failures ? Math.min(30_000, 1000 * 2 ** failures) : syncInterval());
    }
  }
}

async function applyChanges(result: Extract<SyncResponse, { changed: true }>) {
  const keysOf = lookupFrom(result.users);
  actions.setKeyWarnings(await keyring.checkKeys(result.users));
  const conversations = await openConversations(result.conversations, keysOf);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const messages = await Promise.all(
    result.messages.filter((m) => byId.has(m.conversationId)).map((m) => keyring.open(m, byId.get(m.conversationId)!, keysOf)),
  );
  if (!running) return;

  const fresh = messages.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  actions.applySync(result.users, result.projects, conversations, messages);
  for (const message of fresh) if (message.senderId !== meId && message.kind === 'message') onIncoming(message);
}

/** Fetches everything again, for when this device missed a change such as a new chat key. */
async function reloadAll() {
  const data = await api.bootstrap();
  await applyChanges({
    changed: true,
    stamp: data.stamp,
    cursor: data.cursor,
    users: data.users,
    projects: data.projects,
    conversations: data.conversations,
    messages: [],
  });
}

export type StartResult = { status: 'ready' } | { status: 'locked'; me: UserDTO } | { status: 'stale' };

/**
 * Loads the account's data, starts checking in, and wires up alerts. Returns "locked" when this
 * device does not hold the account's keys yet; the user then unlocks with their password.
 */
export async function startChat(signedOut: () => void): Promise<StartResult> {
  const run = ++generation;
  teardown();
  onSignedOut = signedOut;
  const data = await api.bootstrap();
  if (run !== generation) return { status: 'stale' };
  setTabUser(data.me.id);
  if (!(await keyring.load(data.me.id))) return { status: 'locked', me: data.me };

  meId = data.me.id;
  const keysOf = lookupFrom(data.users);
  actions.setKeyWarnings(await keyring.checkKeys(data.users));
  const conversations = await openConversations(data.conversations, keysOf);
  if (run !== generation) return { status: 'stale' };

  actions.bootstrap({ me: data.me, users: data.users, projects: data.projects, conversations });
  cursor = data.cursor;
  stamp = data.stamp;
  running = true;

  const onAway = () => sendAwayBeacon(tabId);
  window.addEventListener('pagehide', onAway);
  window.addEventListener('online', syncNow);
  cleanups.push(
    () => window.removeEventListener('pagehide', onAway),
    () => window.removeEventListener('online', syncNow),
    store.subscribe(syncAlerts),
    attention.subscribe((attentive) => {
      // Tell the server right away, so pushes switch between this tab and the phone.
      void syncNow();
      const activeId = store.get().activeId;
      if (attentive && activeId !== null) markRead(activeId);
    }),
  );

  if ('serviceWorker' in navigator) {
    const onWorkerMessage = (event: MessageEvent<WorkerToPageMessage>) => {
      if (event.data?.type === 'open-conversation') void openConversation(event.data.conversationId);
      // A push means something new: fetch it now instead of waiting for the timer.
      if (event.data?.type === 'push') void syncNow();
    };
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    cleanups.push(() => navigator.serviceWorker.removeEventListener('message', onWorkerMessage));
  }

  void syncPushSubscription()
    .then(refreshPushState)
    .then(() => syncNow());

  // A notification click on a closed app opens /?chat=<id>.
  const requested = Number(new URLSearchParams(location.search).get('chat'));
  if (requested && store.get().conversations[requested]) {
    history.replaceState(null, '', '/');
    void openConversation(requested);
  }
  return { status: 'ready' };
}

export async function refreshPushState() {
  const state = await getPushState();
  pushActiveHere = state.subscribed;
  pushEndpoint = state.endpoint;
  actions.setPush(state);
  return state;
}

/** The text to show for a message in a toast or notification. */
export const previewText = (message: ChatMessage) =>
  message.security === 'failed' ? 'Encrypted message. Open the chat to read it.' : message.text;

function onIncoming(message: ChatMessage) {
  const state = store.get();
  if (attention.isAttentive() && state.activeId === message.conversationId) {
    markRead(message.conversationId);
    return;
  }

  const conversation = state.conversations[message.conversationId];
  if (!conversation) return;
  const sender = state.users[message.senderId]?.displayName ?? 'Someone';
  const isGroup = conversation.type !== 'direct';
  const title = isGroup ? chatTitle(conversation) : sender;
  const body = isGroup ? `${sender}: ${previewText(message)}` : previewText(message);

  if (message.urgent) actions.addUrgent(message);
  else sound.message();

  if (attention.isAttentive()) {
    if (!message.urgent) actions.addToast({ conversationId: message.conversationId, title, body });
  } else if (!pushActiveHere) {
    // Without push on this browser, the server cannot reach it. Show the notification from the page.
    void showLocalNotification(
      message.urgent ? `URGENT from ${title}` : title,
      body,
      message.urgent ? `urgent-${message.id}` : `chat-${message.conversationId}`,
      message.urgent,
      message.conversationId,
    );
  }
}

let lastAlertState = '';

/** Keeps the tab title, favicon, app badge and urgent ringing in step with the store. */
function syncAlerts() {
  const state = store.get();
  const unread = Object.values(state.conversations).reduce((sum, c) => sum + c.unread, 0);
  const first = state.urgent[0];
  const urgentFrom = first ? (state.users[first.senderId]?.displayName ?? 'Someone') : null;
  const key = `${unread}|${urgentFrom}`;
  if (key === lastAlertState) return;
  lastAlertState = key;
  showUnreadInTab(unread, urgentFrom);
  if (urgentFrom) sound.startRinging();
  else sound.stopRinging();
}

export function markRead(conversationId: number) {
  const state = store.get();
  const conversation = state.conversations[conversationId];
  const newest = conversation?.lastMessage;
  const meId = state.me?.id;
  if (!conversation || !newest || meId === undefined) return;
  actions.clearUrgent(conversationId, newest.id);
  const mine = conversation.members.find((m) => m.userId === meId);
  if (conversation.unread === 0 && mine && mine.lastReadId >= newest.id) return;
  actions.setUnread(conversationId, 0);
  actions.applyReceipt({
    conversationId,
    userId: meId,
    lastDeliveredId: Math.max(mine?.lastDeliveredId ?? 0, newest.id),
    lastReadId: newest.id,
  });
  api.markRead(conversationId, newest.id).catch((error: unknown) => console.warn('Could not mark read', error));
}

export async function openConversation(conversationId: number) {
  const conversation = store.get().conversations[conversationId];
  if (conversation) actions.setTab(conversation.type === 'channel' ? 'projects' : 'chats');
  actions.setActive(conversationId);
  if (!store.get().messages[conversationId]) await loadOlder(conversationId);
  if (attention.isAttentive()) markRead(conversationId);
}

export async function loadOlder(conversationId: number) {
  const state = store.get();
  const conversation = state.conversations[conversationId];
  if (!conversation || state.historyComplete[conversationId]) return;
  const oldest = state.messages[conversationId]?.find((m) => m.id > 0);
  const raw = await api.messages(conversationId, oldest?.id);
  const keysOf = currentLookup();
  const page = await Promise.all(raw.map((m) => keyring.open(m, conversation, keysOf)));
  for (const m of page) seen.add(m.id);
  actions.setHistory(conversationId, page, page.length < LIMITS.pageSize);
}

/** Adds a chat the server just returned, keeping the key this device created for it. */
async function adoptConversation(dto: ConversationDTO, created?: { keyId: string; key: CryptoKey }) {
  if (created && dto.keyId === created.keyId) await keyring.remember(dto.id, created.keyId, created.key);
  const [conversation] = await openConversations([dto], currentLookup());
  actions.upsertConversation(conversation!);
  return dto.id;
}

const warnedIds = () => new Set(Object.keys(store.get().keyWarnings).map(Number));

/** Opens the direct chat with a person, creating it with a fresh encrypted key if needed. */
export async function startDirectChat(userId: number): Promise<number> {
  const state = store.get();
  const existing = Object.values(state.conversations).find(
    (c) => c.type === 'direct' && c.members.some((m) => m.userId === userId),
  );
  if (existing) return existing.id;
  const other = state.users[userId];
  if (!other) throw new Error('Person not found.');
  const { input, key } = await keyring.createChatKey(
    [
      { id: meId, name: 'You', keys: keyring.myKeys() },
      { id: other.id, name: other.displayName, keys: other.keys },
    ],
    warnedIds(),
  );
  return adoptConversation(await api.openDirect(userId, input), { keyId: input.keyId, key });
}

export async function startGroupChat(title: string, memberIds: number[]): Promise<number> {
  const state = store.get();
  const members = [
    { id: meId, name: 'You', keys: keyring.myKeys() },
    ...memberIds.map((id) => ({ id, name: state.users[id]?.displayName ?? 'Someone', keys: state.users[id]?.keys ?? null })),
  ];
  const { input, key } = await keyring.createChatKey(members, warnedIds());
  return adoptConversation(await api.createGroup(title, memberIds, input), { keyId: input.keyId, key });
}

/** Returns the chat's key, giving a chat from before encryption its first key if it has none. */
async function ensureChatKey(conversationId: number, retried = false): Promise<{ key: CryptoKey; keyId: string }> {
  const state = store.get();
  const conversation = state.conversations[conversationId];
  if (!conversation) throw new Error('Chat not found.');
  const keysOf = currentLookup();
  if (conversation.keyId) {
    const key = await keyring.chatKey(conversation, keysOf);
    if (!key) throw new EncryptionUnavailableError('This chat has no key for you. Reload the page.');
    return { key, keyId: conversation.keyId };
  }
  const members = conversation.members.map((m) => ({
    id: m.userId,
    name: m.userId === meId ? 'You' : (state.users[m.userId]?.displayName ?? 'Someone'),
    keys: keysOf(m.userId),
  }));
  const { input, key } = await keyring.createChatKey(members, warnedIds());
  try {
    await adoptConversation(await api.setChatKey(conversationId, input), { keyId: input.keyId, key });
    return { key, keyId: input.keyId };
  } catch (error) {
    // Another member set a key first: use theirs.
    if (!retried && error instanceof ApiError && error.code === 'has_key') {
      await reloadAll();
      return ensureChatKey(conversationId, true);
    }
    throw error;
  }
}

/** What a reply carries of the message it answers. */
export const quoteOf = (message: ChatMessage): QuotedMessage => ({
  id: message.id,
  senderId: message.senderId,
  text: message.text.slice(0, LIMITS.quoteLength),
});

export async function sendMessage(conversationId: number, body: string, urgent: boolean, replyTo: QuotedMessage | null = null) {
  const me = store.get().me;
  const text = body.trim();
  if (!me || !text) return;
  const clientId = newClientId();
  actions.addSending({
    id: -Date.now(),
    conversationId,
    senderId: me.id,
    kind: 'message',
    body: '',
    envelope: null,
    urgent,
    createdAt: Date.now(),
    clientId,
    text,
    replyTo,
    reaction: null,
    security: 'encrypted',
  });
  try {
    const { key, keyId } = await ensureChatKey(conversationId);
    const content = replyTo ? { text, replyTo } : { text };
    const envelope = await keyring.seal(key, keyId, { conversationId, urgent, clientId, kind: 'message' }, content);
    const message = await api.sendMessage(conversationId, { envelope, urgent, clientId, kind: 'message' });
    seen.add(message.id);
    keyring.rememberContent(message.id, content);
    actions.addMessage({ ...message, text, replyTo, reaction: null, security: 'encrypted' }, false);
    actions.setPending(clientId, null);
    // Check back soon, so "delivered" shows up without waiting for the regular timer.
    schedule(2500);
  } catch (error) {
    actions.setPending(clientId, 'failed');
    if (error instanceof ApiError && error.code === 'stale_key') void reloadAll();
    if (error instanceof EncryptionUnavailableError || (error instanceof ApiError && error.status >= 400)) {
      actions.addToast({ conversationId, title: 'Message not sent', body: error.message });
    }
  }
}

export function retryMessage(message: ChatMessage) {
  actions.dropSending(message.conversationId, message.clientId!);
  actions.setPending(message.clientId!, null);
  void sendMessage(message.conversationId, message.text, message.urgent, message.replyTo);
}

/** Puts an emoji on a message, or takes it back when it is already this user's reaction there. */
export async function react(message: ChatMessage, emoji: string) {
  const state = store.get();
  const me = state.me;
  if (!me || message.id <= 0) return;
  const { conversationId } = message;
  const previous = state.reactions[conversationId]?.[message.id]?.[me.id] ?? { eventId: 0, emoji: '' };
  const next = previous.emoji === emoji ? '' : emoji;
  actions.setMyReaction(conversationId, message.id, me.id, { eventId: Number.MAX_SAFE_INTEGER, emoji: next });
  try {
    const { key, keyId } = await ensureChatKey(conversationId);
    const clientId = newClientId();
    const content = { text: '', reaction: { messageId: message.id, emoji: next } };
    const envelope = await keyring.seal(key, keyId, { conversationId, urgent: false, clientId, kind: 'reaction' }, content);
    const event = await api.sendMessage(conversationId, { envelope, urgent: false, clientId, kind: 'reaction' });
    seen.add(event.id);
    keyring.rememberContent(event.id, content);
    actions.setMyReaction(conversationId, message.id, me.id, { eventId: event.id, emoji: next });
  } catch (error) {
    actions.setMyReaction(conversationId, message.id, me.id, previous);
    actions.addToast({ conversationId, title: 'Reaction not sent', body: (error as Error).message });
  }
}

/** A project starts with its #general channel. Returns that channel's id. */
export async function createProject(name: string, memberIds: number[]): Promise<number> {
  const state = store.get();
  const members = [
    { id: meId, name: 'You', keys: keyring.myKeys() },
    ...memberIds.map((id) => ({ id, name: state.users[id]?.displayName ?? 'Someone', keys: state.users[id]?.keys ?? null })),
  ];
  const { input, key } = await keyring.createChatKey(members, warnedIds());
  const { project, channel } = await api.createProject({ name, memberIds, key: input });
  actions.upsertProject(project);
  return adoptConversation(channel, { keyId: input.keyId, key });
}

/**
 * Runs a change to a project. When the server says the project changed meanwhile (a member or a
 * channel was added), it reloads and tries once more, so nobody is left out of a channel key.
 */
async function withFreshProject<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'stale_project')) throw error;
    await reloadAll();
    return work();
  }
}

/** Adds a channel, with a new key for every member of the project. Returns the channel's id. */
export function createChannel(projectId: number, name: string): Promise<number> {
  return withFreshProject(async () => {
    const state = store.get();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');
    const members = project.memberIds.map((id) => ({
      id,
      name: id === meId ? 'You' : (state.users[id]?.displayName ?? 'Someone'),
      keys: id === meId ? keyring.myKeys() : (state.users[id]?.keys ?? null),
    }));
    const { input, key } = await keyring.createChatKey(members, warnedIds());
    return adoptConversation(await api.createChannel(projectId, { name, key: input }), { keyId: input.keyId, key });
  });
}

/** Adds people to a project, sharing every channel key with them so they can read the history. */
export function addProjectMembers(projectId: number, userIds: number[]): Promise<void> {
  return withFreshProject(async () => {
    const state = store.get();
    const keysOf = currentLookup();
    const recipients = userIds.map((id) => ({
      id,
      name: state.users[id]?.displayName ?? 'Someone',
      keys: state.users[id]?.keys ?? null,
    }));
    const channels = Object.values(state.conversations).filter((c) => c.projectId === projectId);
    const channelKeys = await Promise.all(
      channels.map(async (c) => ({
        conversationId: c.id,
        keyId: c.keyId ?? '',
        wrappedKeys: await keyring.shareChatKey(c, keysOf, recipients, warnedIds()),
      })),
    );
    actions.upsertProject(await api.addProjectMembers(projectId, { userIds, channelKeys }));
    void syncNow();
  });
}

/** Accepts a person's changed keys after the user compared security codes with them. */
export async function trustKeys(user: UserDTO) {
  await keyring.trust(user);
  actions.setKeyWarnings(await keyring.checkKeys(Object.values(store.get().users)));
}

function teardown() {
  running = false;
  setTabUser(null);
  clearTimeout(timer);
  for (const cleanup of cleanups.splice(0)) cleanup();
  seen.clear();
  cursor = 0;
  stamp = '';
  sound.stopRinging();
  showUnreadInTab(0, null);
  lastAlertState = '';
  actions.reset();
}

async function endSession() {
  teardown();
  // The keys stay usable only while signed in on this device.
  await keyring.forget();
  onSignedOut();
}

export async function signOut() {
  sendAwayBeacon(tabId);
  await forgetPushOnServer();
  await api.logout().catch(() => undefined);
  await endSession();
  announceAccountChange();
}
