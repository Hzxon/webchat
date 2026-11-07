// Keeps the page in step with the server and decides how each incoming message alerts the user.
//
// There is no open connection: the server runs as short-lived serverless functions. Instead the
// page checks in with POST /api/sync. A push from the service worker makes it check in at once;
// otherwise it checks in on a timer that is faster when the user is looking and push is off.
//
// Everything the server sends is decrypted on the way in, and every message is encrypted on the
// way out (see e2ee/keyring.ts). The store only ever holds readable text.
import { keyFingerprint, pairingId, pairingProof, type MessageContent, type QuotedMessage } from '../../shared/e2ee';
import {
  LIMITS,
  previewOf,
  showsEveryPush,
  type ConversationDTO,
  type DocDTO,
  type PullCardDTO,
  type PullRequestDTO,
  type MessageDTO,
  type PublicKeysDTO,
  type RunDTO,
  type RunRequest,
  type SendMessageInput,
  type SyncResponse,
  type UserDTO,
  type WorkerToPageMessage,
} from '../../shared/types';
import { showUnreadInTab, sound } from './alerts';
import { announceAccountChange, api, ApiError, sendAwayBeacon, setTabUser } from './api';
import { attention } from './attention';
import { holdReloadWhile, setReloadTarget } from './build';
import {
  EncryptionUnavailableError,
  keyring,
  type ChatConversation,
  type ChatDoc,
  type ChatMessage,
  type KeyLookup,
} from './e2ee/keyring';
import { keystore, type StoredUnsent } from './e2ee/keystore';
import { refreshGithub, startGithub } from './github';
import { disablePushHere, forgetPushOnServer, getPushState, showLocalNotification, syncPushSubscription } from './push';
import type { Card } from './board';
import { keyedQueue } from './queue';
import { agentChats, agentOf, ownAgents, threadsOf } from './agents';
import { actions, chatTitle, localEditCount, reloadPath, senderName, store, type State } from './store';

const newClientId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const tabId = newClientId();
// While a tab keeps unsent messages, it holds a lock named after it. Each unsent message names its
// tab, so a tab that opens later takes over only those of tabs that have closed (D-051).
const TAB_LOCK = 'webchat-tab:';
/** Ends the lock this tab holds, or null while it holds none. */
let releaseTabLock: (() => void) | null = null;
let running = false;
let meId = 0;
let cursor = 0;
let stamp = '';
let pushActiveHere = false;
let pushEndpoint: string | null = null;
/** The doc section this tab edits. Each check-in names it, so the server keeps its lock (R-020). */
let editing: { docId: string; section: string } | null = null;
/** Messages already handled, so the overlap that sync re-sends never alerts twice. */
const seen = new Set<number>();
/** Client ids of the messages this tab keeps on the device until the server has them (D-051). */
const unsent = new Set<string>();
// The server numbers messages as they arrive, so a chat's sends go out one at a time (D-075).
const sendInOrder = keyedQueue();
/**
 * Messages up to this id were in the chats when the page loaded, so they never alert. `seen` starts
 * empty on every load, and sync re-sends the last few seconds of messages as an overlap.
 */
let alertFloor = 0;
/** Check-ins in a row that the server answered with `more`. */
let catchUpRounds = 0;
const MAX_CATCH_UP_ROUNDS = 10;
/** How far back each chat's history has been paged, by row id. Reaction rows count too. */
const pagedTo = new Map<number, number>();
/** Pages in a row that may bring only reactions before loadOlder stops and waits for a click. */
const MAX_REACTION_PAGES = 10;
let onSignedOut: () => void = () => undefined;
const cleanups: Array<() => void> = [];
// Bumped on every start, so an older start that is still loading knows to stop.
let generation = 0;

/** Public keys by person: the unlocked keys for oneself, the given server list for everyone else. */
function lookupFrom(users: UserDTO[]): KeyLookup {
  const byId = new Map(users.map((u) => [u.id, u.keys]));
  return (userId) => (userId === meId ? keyring.myKeys() : (byId.get(userId) ?? null));
}

export const currentLookup = () => lookupFrom(Object.values(store.get().users));

const openConversations = (list: ConversationDTO[], keysOf: KeyLookup): Promise<ChatConversation[]> =>
  Promise.all(list.map(async (c) => ({ ...c, lastMessage: c.lastMessage ? await keyring.open(c.lastMessage, c, keysOf) : null })));

/** Decrypts each doc's title. A doc whose chat this page does not list is left out. */
export function openDocs(list: DocDTO[], conversations: ChatConversation[], keysOf: KeyLookup): Promise<ChatDoc[]> {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return Promise.all(
    list
      .filter((d) => byId.has(d.conversationId))
      .map(async (d) => {
        const title = d.title && (await keyring.openDoc(d.title, byId.get(d.conversationId)!, keysOf));
        return { ...d, name: title ? title.text || 'Untitled doc' : 'Doc that could not be decrypted', board: title?.board };
      }),
  );
}

export function setEditing(section: typeof editing) {
  editing = section;
}

/** How long to wait before the next check-in. */
function syncInterval(): number {
  // Safari gets no push while the user looks (D-047), so its tab checks in as often as one without push.
  if (attention.isAttentive()) return pushActiveHere && !showsEveryPush(pushEndpoint) ? 15_000 : 3_000;
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
    const since = localEditCount();
    const result = await api.sync({ cursor, stamp, attentive: attention.isAttentive(), tabId, endpoint: pushEndpoint, editing });
    failures = 0;
    actions.setConnected(true);
    // An answer this page changed a chat under is dropped whole. Stamp and cursor stay, so the
    // check-in that follows at once brings everything it held again (D-069).
    if (result.changed && !(await applyChanges(result, since))) {
      again = true;
      return;
    }
    stamp = result.stamp;
    cursor = Math.max(cursor, result.cursor);
    // The server holds more than one answer carries: fetch the rest now, for a few rounds at most.
    if (result.changed && result.more && catchUpRounds < MAX_CATCH_UP_ROUNDS) {
      catchUpRounds++;
      again = true;
    } else {
      catchUpRounds = 0;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      void sessionExpired();
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

/** Returns false when it applied nothing: the page stopped, or changed a chat after `since`. */
async function applyChanges(result: Extract<SyncResponse, { changed: true }>, since: number): Promise<boolean> {
  const keysOf = lookupFrom(result.users);
  actions.setKeyWarnings(await keyring.checkKeys(result.users));
  const conversations = await openConversations(result.conversations, keysOf);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const messages = await Promise.all(
    result.messages.filter((m) => byId.has(m.conversationId)).map((m) => keyring.open(m, byId.get(m.conversationId)!, keysOf)),
  );
  const docs = await openDocs(result.docs, conversations, keysOf);
  if (!running) return false;

  const before = store.get();
  if (!actions.applySync(result.users, result.projects, conversations, messages, docs, since)) return false;
  const fresh = messages.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  for (const message of fresh) if (shouldAlert(message, byId.get(message.conversationId)!)) onIncoming(message);
  // The server has these after all, for example from a tab that closed before it heard back.
  for (const message of messages) if (message.senderId === meId && message.clientId) forgetUnsent(message.clientId);

  // Its owner deleted the open chat or removed this user from it. The chat closes, so say why. A
  // toast shows one line of text, so the title names the chat and the text stays short for phones.
  const open = before.activeId === null ? undefined : before.conversations[before.activeId];
  if (open && !byId.has(open.id)) {
    actions.addToast({ conversationId: null, title: chatTitle(open, before), body: 'It was deleted, or you were removed.' });
  }

  // Someone left these chats. The first member's browser to notice gives each a new key; a failure
  // here waits for the next send, which tries again and says why.
  for (const c of conversations) if (c.keyId && c.needsNewKey) replaceChatKey(c.id).catch(() => undefined);
  return true;
}

/**
 * Only a message that is new to this user alerts. Not one from before the page loaded, which sync
 * re-sends as its overlap; not one their read pointer already covers, such as a project's history
 * when they join (D-026); and not one without encryption. The server has refused those since
 * encryption came, so a new one can only come from someone writing to the database (D-019). A
 * card from GitHub alerts like a message.
 */
function shouldAlert(message: ChatMessage, conversation: ChatConversation): boolean {
  if (message.senderId === meId || message.kind === 'reaction' || message.security === 'plain') return false;
  const readUpTo = conversation.members.find((m) => m.userId === meId)?.lastReadId ?? 0;
  return message.id > alertFloor && message.id > readUpTo;
}

/**
 * Alerts for the urgent messages that came while no page was open (D-078), unless this device
 * dismissed them. Every other message from before the page loaded stays quiet (D-049).
 */
async function alertMissedUrgent(urgent: MessageDTO[], keysOf: KeyLookup, run: number) {
  const dismissed = new Set(await keystore.getDismissed().catch(() => undefined));
  // The server lists each chat's newest unread one from the last 3 days, so the others never come back.
  keystore.setDismissed(urgent.map((m) => m.id).filter((id) => dismissed.has(id))).catch(() => undefined);
  const { conversations } = store.get();
  const missed = await Promise.all(
    urgent
      .filter((m) => conversations[m.conversationId] && !dismissed.has(m.id))
      .map((m) => keyring.open(m, conversations[m.conversationId]!, keysOf)),
  );
  if (run !== generation) return;
  // Only a signature that checks out shows that the sender, not the server, made it urgent (D-016).
  for (const message of missed) if (message.security === 'encrypted') onIncoming(message);
}

/** Clears an urgent alert, and keeps it from alerting again when a page opens on this device (D-078). */
export function dismissUrgent(message: ChatMessage) {
  actions.clearUrgent(message.conversationId, message.id);
  keystore
    .getDismissed()
    .then((ids = []) => keystore.setDismissed([...ids, message.id]))
    .catch(() => undefined);
}

/** Fetches everything again, for when this device missed a change such as a new chat key. */
async function reloadAll() {
  // Its callers go on with what it loads, so a load this page changed a chat under is fetched again.
  for (;;) {
    const since = localEditCount();
    const data = await api.bootstrap();
    const applied = await applyChanges(
      {
        changed: true,
        stamp: data.stamp,
        cursor: data.cursor,
        users: data.users,
        projects: data.projects,
        conversations: data.conversations,
        messages: [],
        more: false,
        docs: data.docs,
      },
      since,
    );
    if (applied || !running) return;
  }
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
  const docs = await openDocs(data.docs, conversations, keysOf);
  const docsSeen = (await keystore.getDocsSeen().catch(() => undefined)) ?? {};
  if (run !== generation) return { status: 'stale' };

  actions.bootstrap({ me: data.me, users: data.users, projects: data.projects, conversations, docs, docsSeen });
  cursor = data.cursor;
  alertFloor = data.cursor;
  stamp = data.stamp;
  running = true;

  const onAway = () => sendAwayBeacon(tabId);
  window.addEventListener('pagehide', onAway);
  window.addEventListener('online', syncNow);
  cleanups.push(
    () => window.removeEventListener('pagehide', onAway),
    () => window.removeEventListener('online', syncNow),
    store.subscribe(syncAlerts),
    warnWhileSending(),
    // A reload after a deploy waits while an alert rings or a message is not sent yet (D-040).
    holdReloadWhile(() => {
      const state = store.get();
      return state.urgent.length > 0 || Object.keys(state.pending).length > 0 || editing !== null;
    }),
    // After a deploy, the reload opens the same chat, pane or board again, as a notification click would.
    setReloadTarget(() => reloadPath(store.get())),
    attention.subscribe((attentive) => {
      // Tell the server right away, so pushes switch between this tab and the phone.
      void syncNow();
      const state = store.get();
      if (attentive) viewedChats(state).forEach(markRead);
    }),
  );

  if ('serviceWorker' in navigator) {
    const onWorkerMessage = (event: MessageEvent<WorkerToPageMessage>) => {
      if (event.data?.type === 'open-conversation') void openConversation(event.data.conversationId);
      // A push means something new: fetch it now instead of waiting for the timer.
      if (event.data?.type === 'push') void (event.data.payload.kind === 'github' ? refreshGithub() : syncNow());
      // The same steps as at start. Saving the subscription again from here names this tab's
      // account (D-008) and covers a save the worker could not finish.
      if (event.data?.type === 'subscription-changed') void syncPushSubscription().then(refreshPushState).then(() => syncNow());
    };
    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    cleanups.push(() => navigator.serviceWorker.removeEventListener('message', onWorkerMessage));
  }

  void syncPushSubscription()
    .then(refreshPushState)
    .then(() => syncNow());
  cleanups.push(startGithub(() => pushActiveHere));
  void alertMissedUrgent(data.urgent, keysOf, run);

  // A notification click on a closed app opens /?chat=<id>.
  const query = new URLSearchParams(location.search);
  const requested = Number(query.get('chat'));
  let opening = Promise.resolve();
  if (requested && store.get().conversations[requested]) {
    history.replaceState(null, '', '/');
    opening = openConversation(requested);
  }
  const doc = query.get('doc');
  if (doc && store.get().docs[doc]) {
    history.replaceState(null, '', '/');
    actions.setDocOpen(doc);
  }
  const board = Number(query.get('board'));
  if (board && store.get().projects[board]) {
    history.replaceState(null, '', '/');
    actions.setBoardOpen(board);
  }
  const agents = query.get('agents');
  if (agents !== null) {
    history.replaceState(null, '', '/');
    actions.setAgentsOpen(true, agents || null);
  }
  // After the chat above, so the two never load the same history at once. The Coding agents row
  // shows the newest conversation, so the chats with agents load too (D-103).
  void opening.catch(() => undefined).then(async () => {
    await Promise.all(agentChats(store.get()).map((chat) => (store.get().messages[chat.id] ? undefined : loadOlder(chat.id).catch(() => undefined))));
    return restoreUnsent(run);
  });
  return { status: 'ready' };
}

/**
 * Asks before the tab closes or reloads while a message is still on its way. The message would come
 * back as not sent (D-051), but the person it is for would wait until this device opens WebChat again.
 */
function warnWhileSending(): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // For older browsers, such as Chrome before 119.
    event.returnValue = true;
  };
  // Listening only while needed: some browsers keep a page that listens out of the back/forward cache.
  let listening = false;
  const unsubscribe = store.subscribe(() => {
    const sending = Object.values(store.get().pending).includes('sending');
    if (sending === listening) return;
    listening = sending;
    if (sending) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  });
  return () => {
    unsubscribe();
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

/** Ids of the tabs open on this device now, from the locks they hold. */
async function openTabs(): Promise<Set<string>> {
  const held = (await navigator.locks?.query().catch(() => undefined))?.held ?? [];
  return new Set(held.flatMap((lock) => (lock.name?.startsWith(TAB_LOCK) ? [lock.name.slice(TAB_LOCK.length)] : [])));
}

/**
 * Brings back the messages that tabs now closed never heard the server confirm (D-051). Each shows
 * in its chat as not sent, unless the chat's history shows that the server has it after all.
 */
async function restoreUnsent(run: number) {
  const [entries, open] = await Promise.all([keystore.getUnsent().catch((): StoredUnsent[] => []), openTabs()]);
  const byChat = new Map<number, StoredUnsent[]>();
  for (const entry of entries) {
    if (entry.userId !== meId || (entry.tabId !== tabId && open.has(entry.tabId))) continue;
    // The chat is gone, or this user is no longer in it.
    if (!store.get().conversations[entry.conversationId]) {
      keystore.deleteUnsent(entry.clientId).catch(() => undefined);
      continue;
    }
    byChat.set(entry.conversationId, [...(byChat.get(entry.conversationId) ?? []), entry]);
  }
  for (const [conversationId, list] of byChat) {
    if (!store.get().messages[conversationId]) {
      // A failure leaves an empty list, as when a chat opens, and "Show earlier messages" tries again.
      await loadOlder(conversationId).catch(() => actions.setHistory(conversationId, [], false));
    }
    const conversation = store.get().conversations[conversationId];
    if (run !== generation || !conversation) return;
    const settled = new Set(store.get().messages[conversationId]?.map((m) => m.clientId));
    const left = list.filter((entry) => !settled.has(entry.clientId));
    for (const entry of list) if (settled.has(entry.clientId)) keystore.deleteUnsent(entry.clientId).catch(() => undefined);
    for (const entry of left) {
      rememberUnsent({ ...entry, tabId });
      actions.addSending(unsentMessage(entry));
      actions.setPending(entry.clientId, 'failed');
    }
    if (left.length > 0) {
      const body = left.length === 1 ? 'A message you wrote was not sent.' : `${left.length} messages you wrote were not sent.`;
      actions.addToast({ conversationId, title: chatTitle(conversation), body });
    }
  }
}

/** The draft this device keeps for a chat or a doc section, or an empty string (D-051). */
export async function loadDraft(name: number | string): Promise<string> {
  const draft = await keystore.getDraft(name).catch(() => undefined);
  return draft?.userId === meId ? draft.text : '';
}

/** Keeps what a chat's message box or a doc section's editor holds, so closing the tab loses nothing. */
export function saveDraft(name: number | string, text: string) {
  const write = text.trim() ? keystore.setDraft(name, { userId: meId, text }) : keystore.deleteDraft(name);
  write.catch(() => undefined);
}

export async function refreshPushState() {
  const state = await getPushState();
  pushActiveHere = state.subscribed;
  pushEndpoint = state.endpoint;
  actions.setPush(state);
  return state;
}

/** The text to show for a message in a toast, a notification or the chat list. */
export function previewText(message: ChatMessage): string {
  if (message.security === 'failed') return 'Encrypted message. Open the chat to read it.';
  if (message.security === 'plain') return `Not encrypted: ${message.text}`;
  if (message.github) return message.text;
  return previewOf(message);
}

/** The chats the user has in view: the open chat, or every chat with their agents while that pane shows. */
const viewedChats = (state: State) => (state.agentsOpen ? agentChats(state).map((c) => c.id) : state.activeId === null ? [] : [state.activeId]);

function onIncoming(message: ChatMessage) {
  const state = store.get();
  if (attention.isAttentive() && viewedChats(state).includes(message.conversationId)) {
    markRead(message.conversationId);
    return;
  }

  const conversation = state.conversations[message.conversationId];
  if (!conversation) return;
  const sender = senderName(state.users, message.senderId);
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
      { conversationId: message.conversationId },
    );
  }
}

let lastAlertState = '';

/** Keeps the tab title, favicon, app badge and urgent ringing in step with the store. */
function syncAlerts() {
  const state = store.get();
  const unread = Object.values(state.conversations).reduce((sum, c) => sum + c.unread, 0);
  const first = state.urgent[0];
  const urgentFrom = first ? senderName(state.users, first.senderId) : null;
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
  // Never mark read what the chat does not show: its history failed to load, or is still loading.
  if (!conversation || !newest || meId === undefined || !state.messages[conversationId]) return;
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
  // A notification can name a chat this page has not synced yet, or one that is gone.
  if (!store.get().conversations[conversationId]) await reloadAll().catch(() => undefined);
  const conversation = store.get().conversations[conversationId];
  if (!conversation) {
    actions.addToast({ conversationId: null, title: 'Chat not available', body: 'It was deleted, or you were removed.' });
    return;
  }
  actions.setTab(conversation.type === 'channel' ? 'projects' : 'chats');
  // The user's chat with their own coding agent shows as conversations in its pane (D-103).
  const agent = agentOf(store.get(), conversation);
  if (!agent) actions.setActive(conversationId);
  else actions.setAgentsOpen(true);
  await loadChat(conversationId);
  // A notification is for the chat's newest message, so it opens that message's conversation, unless
  // the user went elsewhere while it loaded.
  const now = store.get();
  if (agent && now.agentsOpen && now.agentThread === null) actions.setAgentsOpen(true, threadsOf(now.messages[conversationId] ?? [], meId, agent.id, now.pending)[0]?.root ?? null);
}

/** Loads a chat's newest messages when the page has none yet, and marks it read while the user looks. */
export async function loadChat(conversationId: number) {
  const conversation = store.get().conversations[conversationId];
  if (conversation && !store.get().messages[conversationId]) {
    try {
      await loadOlder(conversationId);
    } catch {
      // An empty list still takes new messages, and "Show earlier messages" tries again.
      actions.setHistory(conversationId, [], false);
      actions.addToast({ conversationId: null, title: chatTitle(conversation), body: 'Could not load the messages. Try again.' });
    }
  }
  if (attention.isAttentive()) markRead(conversationId);
}

/**
 * Loads the page of history before what the chat shows. A page counts reaction rows, which the
 * list leaves out, so it pages from the oldest row fetched and keeps going while pages bring no
 * message. Otherwise a run of reactions would return the same page on every click.
 */
export async function loadOlder(conversationId: number) {
  const conversation = store.get().conversations[conversationId];
  if (!conversation || store.get().historyComplete[conversationId]) return;
  if (!store.get().messages[conversationId]) pagedTo.delete(conversationId);
  for (let pages = 0; pages < MAX_REACTION_PAGES; pages++) {
    const before = pagedTo.get(conversationId) ?? store.get().messages[conversationId]?.find((m) => m.id > 0)?.id;
    const raw: MessageDTO[] = await api.messages(conversationId, before);
    if (raw.length > 0) pagedTo.set(conversationId, raw[0]!.id);
    const keysOf = currentLookup();
    const page = await Promise.all(raw.map((m) => keyring.open(m, conversation, keysOf)));
    for (const m of page) seen.add(m.id);
    const complete = raw.length < LIMITS.pageSize;
    actions.setHistory(conversationId, page, complete);
    if (complete || page.some((m) => m.kind !== 'reaction')) return;
  }
}

/** Adds a chat the server just returned, keeping the key this device created for it. */
async function adoptConversation(dto: ConversationDTO, created?: { keyId: string; key: CryptoKey }) {
  if (created && dto.keyId === created.keyId) await keyring.remember(dto.id, created.keyId, created.key);
  const [conversation] = await openConversations([dto], currentLookup());
  actions.upsertConversation(conversation!);
  return dto.id;
}

const warnedIds = () => new Set(Object.keys(store.get().keyWarnings).map(Number));

/** Someone to wrap a chat key for: this user with their unlocked keys, anyone else with the keys the server lists. */
function keyRecipient(id: number) {
  const user = store.get().users[id];
  return id === meId
    ? { id, name: 'You', keys: keyring.myKeys() }
    : { id, name: user?.displayName ?? 'Someone', keys: user?.keys ?? null };
}

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

/** Key replacements running in this tab, by chat, so a check-in and a send never make two. */
const replacing = new Map<number, Promise<void>>();

/**
 * Gives a chat that someone left a new key for everyone still in it, with the old key inside, so
 * the history stays readable. When another member's browser was first, takes their key instead.
 */
function replaceChatKey(conversationId: number): Promise<void> {
  let pending = replacing.get(conversationId);
  if (!pending) {
    pending = (async () => {
      const conversation = store.get().conversations[conversationId];
      if (!conversation?.keyId || !conversation.needsNewKey) return;
      const members = conversation.members.map((m) => keyRecipient(m.userId));
      const { input, key } = await keyring.rotateChatKey(conversation, currentLookup(), members, warnedIds());
      try {
        await adoptConversation(await api.replaceChatKey(conversationId, input), { keyId: input.keyId, key });
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'stale_key')) throw error;
        await reloadAll();
      }
    })().finally(() => replacing.delete(conversationId));
    replacing.set(conversationId, pending);
  }
  return pending;
}

/**
 * Returns the chat's key. Gives a chat that someone left a new key first, and a chat from before
 * encryption its first key if it has none.
 */
async function ensureChatKey(conversationId: number, retried = false): Promise<{ key: CryptoKey; keyId: string }> {
  const state = store.get();
  const conversation = state.conversations[conversationId];
  if (!conversation) throw new Error('Chat not found.');
  const keysOf = currentLookup();
  if (conversation.keyId && conversation.needsNewKey) {
    // Never send with a key that someone who left holds.
    if (retried) throw new EncryptionUnavailableError('Someone left this chat, and its new key is not ready yet. Try again.');
    await replaceChatKey(conversationId);
    return ensureChatKey(conversationId, true);
  }
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
    // Another member set a key first, or the members changed: reload, then use the key or try again.
    if (!retried && error instanceof ApiError && (error.code === 'has_key' || error.code === 'stale_group')) {
      await reloadAll();
      return ensureChatKey(conversationId, true);
    }
    throw error;
  }
}

/**
 * Seals and sends something with the chat's key. When the chat got a new key meanwhile, or someone
 * left it, this reloads and tries once more with the chat's next key.
 */
export async function withChatKey<T>(conversationId: number, work: (key: CryptoKey, keyId: string) => Promise<T>, retried = false): Promise<T> {
  const { key, keyId } = await ensureChatKey(conversationId);
  try {
    return await work(key, keyId);
  } catch (error) {
    if (retried || !(error instanceof ApiError && (error.code === 'stale_key' || error.code === 'needs_new_key'))) throw error;
    await reloadAll();
    return withChatKey(conversationId, work, true);
  }
}

/** Encrypts and sends a message or reaction. */
const sealAndSend = (
  conversationId: number,
  meta: { urgent: boolean; clientId: string; kind: NonNullable<SendMessageInput['kind']> },
  content: MessageContent,
): Promise<MessageDTO> =>
  withChatKey(conversationId, async (key, keyId) => {
    const envelope = await keyring.seal(key, keyId, { conversationId, ...meta }, content);
    const message = await api.sendMessage(conversationId, { envelope, ...meta });
    // This device knows what it sent, so it never needs to decrypt it.
    keyring.rememberContent(message.id, { conversationId, senderId: meId, ...meta }, envelope, content);
    return message;
  });

/** What a reply carries of the message it answers. A card from GitHub has no sender, so it quotes 0. */
export const quoteOf = (message: ChatMessage): QuotedMessage => ({
  id: message.id,
  senderId: message.senderId ?? 0,
  text: message.text.slice(0, LIMITS.quoteLength),
});

export function sendMessage(conversationId: number, body: string, urgent: boolean, replyTo: QuotedMessage | null = null) {
  const text = body.trim();
  if (!text) return Promise.resolve();
  return sendContent(conversationId, replyTo ? { text, replyTo } : { text }, urgent);
}

/**
 * Hands a board card to the user's coding agent (R-027, D-089, D-105): a message in their direct
 * chat with it whose `run` field names the card, the agent's account, the repository whose Claude
 * Code session runs it (D-094), when it was sent, and the hash of the brief the owner saw. The agent
 * answers with reports that name this message, which the pane and the board fold into the card. The
 * text says the same in words. Returns the conversation, by the request's client id.
 */
export async function requestRun(docId: string, card: Card, runtime: UserDTO, repo: string, hash: string) {
  const conversationId = await startDirectChat(runtime.id);
  const id = `${card.kind}-${card.number}`;
  const run: RunRequest = { kind: 'request', card: id, title: card.title.slice(0, LIMITS.runNoteLength), docId, section: card.id, runtime: runtime.id, sentAt: Date.now(), repo, hash, was: card.status };
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
  return sendContent(conversationId, { text: note.trim() || 'Let the agent fix it.', run: fix }, false);
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
 * Asks one of the user's coding agents in a project (D-102, R-038): a message in their direct chat
 * with it, whose `prompt` field names the project, whose board alone goes in the brief (D-104), and
 * one of its repositories, or none for a project that links none. The agent's laptop answers.
 * Returns the conversation, by the prompt's client id.
 */
export async function askAgent(agentId: number, project: number, repo: string | undefined, question: string) {
  const conversationId = await startDirectChat(agentId);
  const clientId = newClientId();
  // The message shows as sending at once, so the pane can open its conversation.
  void sendContent(conversationId, { text: question.trim(), prompt: { kind: 'prompt', sentAt: Date.now(), project, ...(repo && { repo }) } }, false, clientId);
  return clientId;
}

/** Has the user's agent forget its folder of a repository: the mark goes, never the files (R-038, D-101). */
export async function forgetFolder(agentId: number, repo: string) {
  await sendContent(await startDirectChat(agentId), { text: `Forget the folder of ${repo}`, forget: { repo, sentAt: Date.now() } }, false);
}

/** Replies in a conversation with an agent, or stops its turn. Both name the prompt's client id (D-102). */
export function tellAgent(conversationId: number, to: string, kind: 'reply' | 'cancel', text: string) {
  return sendContent(conversationId, { text: text.trim(), prompt: { kind, to, sentAt: Date.now() } }, false);
}

/** Tells the user's other devices that their page put an agent's card draft on the board (D-104). The agent ignores it. */
export function noteAdded(conversationId: number, to: string, draft: string, card: string) {
  return sendContent(conversationId, { text: `Added ${card} to the board.`, added: { to, draft, card } }, false);
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
 * D-093). Null while it has not. The code stays in this page: the server sees only a hash of it.
 */
export async function pairingKeys(code: string): Promise<PublicKeysDTO | null> {
  const pairing = await api.pairing(await pairingId(code));
  if (!pairing) return null;
  if (pairing.proof !== (await pairingProof(code, pairing.keys))) throw new Error('These keys did not come with the code. Close this window and make a new code.');
  return pairing.keys;
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

/** How a message the server has not confirmed shows in its chat, while it sends and after it failed. */
function unsentMessage(entry: StoredUnsent): ChatMessage {
  return {
    id: -entry.createdAt,
    conversationId: entry.conversationId,
    senderId: entry.userId,
    kind: 'message',
    body: '',
    envelope: null,
    urgent: entry.urgent,
    createdAt: entry.createdAt,
    clientId: entry.clientId,
    text: entry.content.text,
    replyTo: entry.content.replyTo ?? null,
    reaction: null,
    pull: entry.content.pull ?? null,
    github: null,
    run: entry.content.run ?? null,
    prompt: entry.content.prompt ?? null,
    added: entry.content.added ?? null,
    security: 'encrypted',
  };
}

// Writes go to the device in the order they are made, so a quick confirmation cannot be overtaken.
function rememberUnsent(entry: StoredUnsent) {
  unsent.add(entry.clientId);
  holdTabLock();
  keystore.setUnsent(entry).catch(() => undefined);
}

function forgetUnsent(clientId: string) {
  if (!unsent.delete(clientId)) return;
  keystore.deleteUnsent(clientId).catch(() => undefined);
  if (unsent.size === 0) dropTabLock();
}

// Held only while needed: some browsers keep a page that holds a lock out of the back/forward cache.
function holdTabLock() {
  if (releaseTabLock || !navigator.locks) return;
  const held = new Promise<void>((resolve) => {
    releaseTabLock = resolve;
  });
  navigator.locks.request(`${TAB_LOCK}${tabId}`, () => held).catch(() => undefined);
}

function dropTabLock() {
  releaseTabLock?.();
  releaseTabLock = null;
}

/**
 * Encrypts and sends one message, showing it as sending until the server has it. Until then it
 * also stays on the device, so closing or reloading the tab does not lose it (D-051).
 */
async function sendContent(conversationId: number, content: MessageContent, urgent: boolean, clientId = newClientId()) {
  const me = store.get().me;
  if (!me) return;
  const entry: StoredUnsent = { userId: me.id, tabId, conversationId, clientId, urgent, createdAt: Date.now(), content };
  const sending = unsentMessage(entry);
  actions.addSending(sending);
  rememberUnsent(entry);
  try {
    const message = await sendInOrder(conversationId, () => sealAndSend(conversationId, { urgent, clientId, kind: 'message' }, content));
    seen.add(message.id);
    actions.addMessage({ ...sending, ...message }, false);
    actions.setPending(clientId, null);
    forgetUnsent(clientId);
    // Check back soon, so "delivered" shows up without waiting for the regular timer.
    schedule(2500);
  } catch (error) {
    actions.setPending(clientId, 'failed');
    if (error instanceof EncryptionUnavailableError || (error instanceof ApiError && error.status >= 400)) {
      actions.addToast({ conversationId, title: 'Message not sent', body: error.message });
    }
  }
}

/** Takes a message that was not sent out of its chat and off this device, which keeps it until then. */
export function discardMessage(message: ChatMessage) {
  actions.dropSending(message.conversationId, message.clientId!);
  actions.setPending(message.clientId!, null);
  forgetUnsent(message.clientId!);
}

/**
 * Sends a message that was not sent again, under the same client id. When the server had stored it
 * after all and only its answer was lost, it answers with that copy instead of a second one (D-061).
 */
export function retryMessage(message: ChatMessage) {
  const content: MessageContent = { text: message.text };
  if (message.replyTo) content.replyTo = message.replyTo;
  if (message.pull) content.pull = message.pull;
  if (message.run) content.run = 'sentAt' in message.run ? { ...message.run, sentAt: Date.now() } : message.run;
  // A fresh send time, or the agent would refuse a retry made 10 minutes later. The client id still makes it one message (D-061, K-47).
  if (message.prompt) content.prompt = 'sentAt' in message.prompt ? { ...message.prompt, sentAt: Date.now() } : message.prompt;
  if (message.added) content.added = message.added;
  void sendContent(message.conversationId, content, message.urgent, message.clientId!);
}

/** Puts an emoji on a message, or takes it back when it is already this user's reaction there. */
export async function react(message: ChatMessage, emoji: string) {
  const state = store.get();
  const me = state.me;
  if (!me || message.id <= 0) return;
  const { conversationId } = message;
  const previous = state.reactions[conversationId]?.[message.id]?.[me.id] ?? { eventId: 0, emoji: '' };
  const mark = { emoji: previous.emoji === emoji ? '' : emoji, senderId: message.senderId ?? 0, ...(message.clientId && { clientId: message.clientId }) };
  actions.setMyReaction(conversationId, message.id, me.id, { eventId: Number.MAX_SAFE_INTEGER, ...mark });
  try {
    const content = { text: '', reaction: { messageId: message.id, ...mark } };
    const event = await sealAndSend(conversationId, { urgent: false, clientId: newClientId(), kind: 'reaction' }, content);
    seen.add(event.id);
    actions.setMyReaction(conversationId, message.id, me.id, { eventId: event.id, ...mark });
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
 * Runs a change to a project or group. When the server says it changed meanwhile (someone joined
 * or left, or a channel was added), it reloads and tries once more, so every key is wrapped for
 * exactly the people in it.
 */
async function retryIfStale<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError && (error.code === 'stale_project' || error.code === 'stale_group'))) throw error;
    await reloadAll();
    return work();
  }
}

/** Adds a channel, with a new key for every member of the project. Returns the channel's id. */
export function createChannel(projectId: number, name: string): Promise<number> {
  return retryIfStale(async () => {
    const project = store.get().projects[projectId];
    if (!project) throw new Error('Project not found.');
    const { input, key } = await keyring.createChatKey(project.memberIds.map(keyRecipient), warnedIds());
    return adoptConversation(await api.createChannel(projectId, { name, key: input }), { keyId: input.keyId, key });
  });
}

/** Adds people to a project, sharing every channel key with them so they can read the history. */
export function addProjectMembers(projectId: number, userIds: number[]): Promise<void> {
  return retryIfStale(async () => {
    // A channel that someone left gets its new key first, so newcomers never get one they hold.
    const leftBehind = Object.values(store.get().conversations).filter((c) => c.projectId === projectId && c.needsNewKey);
    await Promise.all(leftBehind.map((c) => replaceChatKey(c.id)));
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

/**
 * Removes someone from a project. This browser gives every channel a new key for the people who
 * stay, so the person removed cannot read what is sent next.
 */
export function removeProjectMember(projectId: number, userId: number): Promise<void> {
  return retryIfStale(async () => {
    const state = store.get();
    const project = state.projects[projectId];
    if (!project) throw new Error('Project not found.');
    // Removed already, for example from another tab.
    if (!project.memberIds.includes(userId)) return;
    const keysOf = currentLookup();
    const staying = project.memberIds.filter((id) => id !== userId).map(keyRecipient);
    const channels = Object.values(state.conversations).filter((c) => c.projectId === projectId);
    const rotated = await Promise.all(
      channels.map(async (c) => ({ conversationId: c.id, ...(await keyring.rotateChatKey(c, keysOf, staying, warnedIds())) })),
    );
    const channelKeys = rotated.map(({ conversationId, input }) => ({ conversationId, ...input }));
    actions.upsertProject(await api.removeProjectMember(projectId, userId, { channelKeys }));
    await Promise.all(rotated.map(({ conversationId, input, key }) => keyring.remember(conversationId, input.keyId, key)));
    void syncNow();
  });
}

/** Adds people to a group, sharing its key with them so they can read the history. */
export function addGroupMembers(conversationId: number, userIds: number[]): Promise<void> {
  return retryIfStale(async () => {
    // A group that someone left gets its new key first, so newcomers never get one they hold.
    if (store.get().conversations[conversationId]?.needsNewKey) await replaceChatKey(conversationId);
    const conversation = store.get().conversations[conversationId];
    if (!conversation) throw new Error('Group not found.');
    const key = conversation.keyId
      ? {
          keyId: conversation.keyId,
          wrappedKeys: await keyring.shareChatKey(conversation, currentLookup(), userIds.map(keyRecipient), warnedIds()),
        }
      : null;
    await adoptConversation(await api.addGroupMembers(conversationId, { userIds, key }));
    void syncNow();
  });
}

/** Removes someone from a group, with a new key for the people who stay. */
export function removeGroupMember(conversationId: number, userId: number): Promise<void> {
  return retryIfStale(async () => {
    const conversation = store.get().conversations[conversationId];
    if (!conversation) throw new Error('Group not found.');
    if (!conversation.members.some((m) => m.userId === userId)) return;
    const staying = conversation.members.filter((m) => m.userId !== userId).map((m) => keyRecipient(m.userId));
    // A group from before encryption has no key to replace.
    const rotated = conversation.keyId
      ? await keyring.rotateChatKey(conversation, currentLookup(), staying, warnedIds())
      : null;
    await adoptConversation(
      await api.removeGroupMember(conversationId, userId, { key: rotated?.input ?? null }),
      rotated ? { keyId: rotated.input.keyId, key: rotated.key } : undefined,
    );
    void syncNow();
  });
}

/**
 * Leaves a project. This browser cannot make new keys for the others, so a member who stays gives
 * each channel one before anyone sends there again.
 */
export async function leaveProject(projectId: number) {
  await api.leaveProject(projectId);
  actions.dropProject(projectId);
  void syncNow();
}

/** Leaves a group. A member who stays gives it a new key, as for a project. */
export async function leaveGroup(conversationId: number) {
  await api.leaveGroup(conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}

/** Makes another member the project's owner, so this user can leave it. */
export async function handOverProject(projectId: number, userId: number) {
  actions.upsertProject(await api.handOverProject(projectId, { userId }));
  void syncNow();
}

/** Makes another member the group's owner, so this user can leave it. */
export async function handOverGroup(conversationId: number, userId: number) {
  await adoptConversation(await api.handOverGroup(conversationId, { userId }));
  void syncNow();
}

/** Deletes a project for everyone, with its channels and their messages. */
export async function deleteProject(projectId: number) {
  await api.deleteProject(projectId);
  actions.dropProject(projectId);
  void syncNow();
}

/** Deletes a channel for everyone, with its messages. Only the project's owner can, and never #general. */
export async function deleteChannel(projectId: number, conversationId: number) {
  await api.deleteChannel(projectId, conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}

/** Deletes a group for everyone, with its messages. */
export async function deleteGroup(conversationId: number) {
  await api.deleteGroup(conversationId);
  actions.dropConversation(conversationId);
  void syncNow();
}

/** Accepts a person's changed keys after the user compared security codes with them. */
export async function trustKeys(user: UserDTO) {
  await keyring.trust(user);
  actions.setKeyWarnings(await keyring.checkKeys(Object.values(store.get().users)));
  // What failed under the unchecked keys opens now, without a reload. It never alerts again.
  for (const message of await keyring.reopen(store.get().conversations, currentLookup())) actions.addMessage(message, false);
  // The user's agents pin the same keys, or a card's brief would hash differently there (K-57, D-110).
  if (!user.keys) return;
  const trust = { user: user.id, fingerprint: await keyFingerprint(user.keys), sentAt: Date.now() };
  for (const agent of ownAgents(store.get().users, meId)) {
    await sendContent(await startDirectChat(agent.id), { text: `I checked ${user.displayName}’s security code.`, trust }, false);
  }
}

function teardown() {
  running = false;
  setTabUser(null);
  clearTimeout(timer);
  for (const cleanup of cleanups.splice(0)) cleanup();
  seen.clear();
  unsent.clear();
  dropTabLock();
  pagedTo.clear();
  cursor = 0;
  alertFloor = 0;
  catchUpRounds = 0;
  stamp = '';
  editing = null;
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

/** For a 401 at load or at a check-in: the session expired, often while every tab was closed. */
export async function sessionExpired() {
  // The expired session cannot remove this browser's subscription on the server, so end it in
  // the browser. The push service then refuses the server's next push, and the server deletes
  // the row. Until then, the next person here would see the old account's notifications (K-18).
  void disablePushHere();
  await endSession();
}

/** Deletes the account on the server (R-028), then ends the session here as signing out does. */
export async function deleteAccount() {
  await api.deleteAccount();
  await endSession();
  announceAccountChange();
}

export async function signOut() {
  sendAwayBeacon(tabId);
  await forgetPushOnServer();
  await api.logout().catch(() => undefined);
  await endSession();
  announceAccountChange();
}
