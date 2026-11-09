// Service worker: turns Web Push messages into system notifications, even when no tab is open.
// Pushed messages arrive encrypted; it decrypts them here, on the device, with the keys the page
// left in IndexedDB. vite.sw.config.ts bundles it into one plain script at /sw.js.
import { decryptContent } from '../../shared/e2ee';
import { previewOf, showsEveryPush, type ConfigDTO, type PushPayload, type WorkerToPageMessage } from '../../shared/types';
import { keystore } from './e2ee/keystore';

declare const self: ServiceWorkerGlobalScope;

// Fields Chromium supports that TypeScript's DOM types leave out.
interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean;
  vibrate?: number[];
  timestamp?: number;
}

interface PushSubscriptionChangeEvent extends ExtendableEvent {
  readonly oldSubscription: PushSubscription | null;
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function windowClients(): Promise<readonly WindowClient[]> {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

function post(client: Client, message: WorkerToPageMessage) {
  client.postMessage(message);
}

async function showsEveryPushHere(): Promise<boolean> {
  const subscription = await self.registration.pushManager.getSubscription().catch(() => null);
  return showsEveryPush(subscription?.endpoint ?? null);
}

function preview(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * Decrypts a pushed message with this device's chat key and checks the sender's signature. If
 * the key is not on this device yet, or the check fails, the notification says so without text.
 */
async function notificationBody(payload: PushPayload): Promise<{ body: string; progress?: boolean }> {
  if (payload.kind !== 'message' || !payload.envelope) {
    return { body: payload.body || (payload.urgent ? 'Urgent message. Open the chat to read it.' : 'New message') };
  }
  const { envelope, conversationId, senderId, clientId } = payload;
  try {
    if (conversationId === null || senderId === null || clientId === null) throw new Error('Incomplete push.');
    const [key, directory] = await Promise.all([keystore.getChatKey(conversationId, envelope.kid), keystore.getDirectory()]);
    const senderKeys = directory?.[senderId];
    if (!key || !senderKeys) throw new Error('Keys are not on this device yet.');
    const content = await decryptContent(key, senderKeys.sign, { conversationId, senderId, urgent: payload.urgent, clientId }, envelope);
    return { body: payload.bodyPrefix + preview(previewOf(content)), progress: content.run?.kind === 'progress' };
  } catch {
    return { body: payload.bodyPrefix + (payload.urgent ? 'Urgent message. Open the chat to read it.' : 'New encrypted message') };
  }
}

self.addEventListener('push', (event) => {
  let payload: PushPayload;
  try {
    payload = event.data?.json() as PushPayload;
  } catch {
    payload = {
      kind: 'message',
      title: 'New message',
      body: event.data?.text() ?? '',
      bodyPrefix: '',
      urgent: false,
      tag: 'fallback',
      conversationId: null,
      messageId: null,
      senderId: null,
      clientId: null,
      envelope: null,
      unreadTotal: null,
      sentAt: Date.now(),
      url: null,
    };
  }

  event.waitUntil(
    (async () => {
      const clients = await windowClients();
      for (const client of clients) post(client, { type: 'push', payload });
      // A reaction notifies nobody; its push only wakes the page (D-030). The server can still think
      // the user is looking when nobody is, such as after a laptop slept, so check here (D-070).
      if (payload.kind === 'reaction') return;

      // Lets the sender see "delivered" even while every tab here is closed.
      if (payload.conversationId !== null && payload.messageId !== null) {
        await fetch('/api/delivered', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId: payload.conversationId, messageId: payload.messageId }),
        }).catch(() => undefined);
      }

      // While the user is looking at the app, the server pushes only to that browser so the page can
      // show the message at once. A focused tab shows it already, so only urgent ones also go to the system.
      const someoneLooking = clients.some((c) => c.focused && c.visibilityState === 'visible');
      // Being added to a project or group is rare, and the page has no alert of its own for it.
      // Safari revokes a subscription after a few pushes that show nothing, so there every push
      // shows (D-047); the server already avoids sending those while it knows the user is looking.
      const invite = payload.kind === 'project' || payload.kind === 'group';
      const quiet = someoneLooking && !payload.urgent && payload.kind !== 'test' && !invite;
      if (quiet && !(await showsEveryPushHere())) return;

      if (payload.unreadTotal !== null && 'setAppBadge' in self.navigator) {
        await self.navigator.setAppBadge(payload.unreadTotal).catch(() => undefined);
      }

      // A run's progress line, every half minute, is for the pane, not the lock screen; only Safari
      // shows it, since it revokes a subscription after pushes that show nothing (D-047).
      const { body, progress } = await notificationBody(payload);
      if (progress && !(await showsEveryPushHere())) return;

      const options: ExtendedNotificationOptions = {
        body,
        tag: payload.tag,
        renotify: true,
        requireInteraction: payload.urgent,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        timestamp: payload.sentAt,
        vibrate: payload.urgent ? [400, 150, 400, 150, 400, 150, 800] : [200, 100, 200],
        data: payload.url ? { url: payload.url } : { conversationId: payload.conversationId },
      };
      // The server rings an unread urgent message again every few seconds (D-079). Only Chromium
      // knows renotify; Firefox and Safari swap a notification under the same tag in silence, so
      // the old one closes first and the new one sounds.
      if (payload.urgent) {
        for (const old of await self.registration.getNotifications({ tag: payload.tag })) old.close();
      }
      await self.registration.showNotification(payload.title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { conversationId?: number | null; url?: string } | null;
  const conversationId = data?.conversationId ?? null;

  event.waitUntil(
    (async () => {
      // A pull request alert opens the pull request on GitHub.
      if (data?.url) {
        await self.clients.openWindow(data.url);
        return;
      }
      const clients = await windowClients();
      const existing = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if (conversationId !== null) post(existing, { type: 'open-conversation', conversationId });
        return;
      }
      await self.clients.openWindow(conversationId === null ? '/' : `/?chat=${conversationId}`);
    })(),
  );
});

// Browsers can rotate a subscription. Re-subscribe and tell the server the new address.
self.addEventListener('pushsubscriptionchange', (rawEvent) => {
  const event = rawEvent as PushSubscriptionChangeEvent;
  event.waitUntil(
    (async () => {
      const config = (await (await fetch('/api/config')).json()) as ConfigDTO;
      // The push service no longer takes the old endpoint, but the server would push to it until it
      // answered 404 or 410 (K-33). Deleted before the new one is saved, in case both are the same.
      if (event.oldSubscription) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
        });
      }
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(config.vapidPublicKey),
      });
      // Open pages send their endpoint with each check-in, and the old one is dead now.
      for (const client of await windowClients()) post(client, { type: 'subscription-changed' });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
    })(),
  );
});

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
