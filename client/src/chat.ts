// Keeps the page in step with the server and decides how each incoming message alerts the user.
//
// There is no open connection: the server runs as short-lived serverless functions. Instead the
// page checks in with POST /api/sync. A push from the service worker makes it check in at once;
// otherwise it checks in on a timer that is faster when the user is looking and push is off.
import { LIMITS, type MessageDTO, type SyncResponse, type WorkerToPageMessage } from '../../shared/types';
import { showUnreadInTab, sound } from './alerts';
import { api, ApiError, sendAwayBeacon } from './api';
import { attention } from './attention';
import { forgetPushOnServer, getPushState, showLocalNotification, syncPushSubscription } from './push';
import { actions, chatTitle, store } from './store';

const newClientId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const tabId = newClientId();
let running = false;
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
    stamp = result.stamp;
    cursor = Math.max(cursor, result.cursor);
    if (result.changed) applyChanges(result);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      endSession();
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

function applyChanges(result: Extract<SyncResponse, { changed: true }>) {
  const fresh = result.messages.filter((m) => !seen.has(m.id));
  for (const m of fresh) seen.add(m.id);
  actions.applySync(result.users, result.conversations, result.messages);

  const meId = store.get().me?.id;
  for (const message of fresh) if (message.senderId !== meId) onIncoming(message);
}

/** Loads the account's data, starts checking in, and wires up alerts. */
export async function startChat(signedOut: () => void): Promise<void> {
  const run = ++generation;
  teardown();
  onSignedOut = signedOut;
  const data = await api.bootstrap();
  if (run !== generation) return;

  actions.bootstrap(data);
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
}

export async function refreshPushState() {
  const state = await getPushState();
  pushActiveHere = state.subscribed;
  pushEndpoint = state.endpoint;
  actions.setPush(state);
  return state;
}

function onIncoming(message: MessageDTO) {
  const state = store.get();
  if (attention.isAttentive() && state.activeId === message.conversationId) {
    markRead(message.conversationId);
    return;
  }

  const conversation = state.conversations[message.conversationId];
  if (!conversation) return;
  const sender = state.users[message.senderId]?.displayName ?? 'Someone';
  const isGroup = conversation.type === 'group';
  const title = isGroup ? chatTitle(conversation) : sender;
  const body = isGroup ? `${sender}: ${message.body}` : message.body;

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
  actions.setActive(conversationId);
  if (!store.get().messages[conversationId]) await loadOlder(conversationId);
  if (attention.isAttentive()) markRead(conversationId);
}

export async function loadOlder(conversationId: number) {
  const state = store.get();
  if (state.historyComplete[conversationId]) return;
  const oldest = state.messages[conversationId]?.find((m) => m.id > 0);
  const page = await api.messages(conversationId, oldest?.id);
  for (const m of page) seen.add(m.id);
  actions.setHistory(conversationId, page, page.length < LIMITS.pageSize);
}

export async function sendMessage(conversationId: number, body: string, urgent: boolean) {
  const me = store.get().me;
  const text = body.trim();
  if (!me || !text) return;
  const clientId = newClientId();
  actions.addSending({
    id: -Date.now(),
    conversationId,
    senderId: me.id,
    body: text,
    urgent,
    createdAt: Date.now(),
    clientId,
  });
  try {
    const message = await api.sendMessage(conversationId, { body: text, urgent, clientId });
    seen.add(message.id);
    actions.addMessage(message, false);
    actions.setPending(clientId, null);
    // Check back soon, so "delivered" shows up without waiting for the regular timer.
    schedule(2500);
  } catch {
    actions.setPending(clientId, 'failed');
  }
}

export function retryMessage(message: MessageDTO) {
  actions.dropSending(message.conversationId, message.clientId!);
  actions.setPending(message.clientId!, null);
  void sendMessage(message.conversationId, message.body, message.urgent);
}

function teardown() {
  running = false;
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

function endSession() {
  teardown();
  onSignedOut();
}

export async function signOut() {
  sendAwayBeacon(tabId);
  await forgetPushOnServer();
  await api.logout().catch(() => undefined);
  endSession();
}
