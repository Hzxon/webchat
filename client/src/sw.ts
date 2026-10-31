// Service worker: turns Web Push messages into system notifications, even when no tab is open.
// It must not import runtime code, so the build emits it as one plain script at /sw.js.
import type { ConfigDTO, PushPayload, WorkerToPageMessage } from '../../shared/types';

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

self.addEventListener('push', (event) => {
  let payload: PushPayload;
  try {
    payload = event.data?.json() as PushPayload;
  } catch {
    payload = {
      kind: 'message',
      title: 'New message',
      body: event.data?.text() ?? '',
      urgent: false,
      tag: 'fallback',
      conversationId: null,
      messageId: null,
      unreadTotal: null,
      sentAt: Date.now(),
    };
  }

  event.waitUntil(
    (async () => {
      const clients = await windowClients();
      for (const client of clients) post(client, { type: 'push', payload });

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
      if (someoneLooking && !payload.urgent && payload.kind === 'message') return;

      if (payload.unreadTotal !== null && 'setAppBadge' in self.navigator) {
        await self.navigator.setAppBadge(payload.unreadTotal).catch(() => undefined);
      }

      const options: ExtendedNotificationOptions = {
        body: payload.body,
        tag: payload.tag,
        renotify: true,
        requireInteraction: payload.urgent,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        timestamp: payload.sentAt,
        vibrate: payload.urgent ? [400, 150, 400, 150, 400, 150, 800] : [200, 100, 200],
        data: { conversationId: payload.conversationId },
      };
      await self.registration.showNotification(payload.title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = (event.notification.data as { conversationId?: number | null } | null)?.conversationId ?? null;

  event.waitUntil(
    (async () => {
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
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(config.vapidPublicKey),
      });
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
