// Browser notification permission and the Web Push subscription for this device.
import { api, ApiError } from './api';
import { iosVersion } from './ios';

export type PermissionState = NotificationPermission | 'unsupported';

export interface PushState {
  permission: PermissionState;
  /** False on browsers without Web Push, including iPhone Safari outside a home-screen app. */
  pushSupported: boolean;
  /** This browser has a push subscription saved on the server. */
  subscribed: boolean;
  /** The subscription's endpoint, sent with each check-in so the server can push to this tab. */
  endpoint: string | null;
  /** iPhone or iPad, not opened from the home screen: push needs "Add to Home Screen" first. */
  needsInstall: boolean;
  /** iOS before 16.4, which has no Web Push even from the home screen. */
  oldIos: boolean;
}

const isIos =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const oldIos = (iosVersion(navigator.userAgent) ?? Infinity) < 16.4;

let registration: Promise<ServiceWorkerRegistration | null> | undefined;

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  registration ??= navigator.serviceWorker
    // Dev serves the TypeScript worker as an ES module; the production build is a plain script.
    .register('/sw.js', import.meta.env.DEV ? { type: 'module' } : undefined)
    .then(() => navigator.serviceWorker.ready)
    .catch((error: unknown) => {
      console.warn('Service worker registration failed', error);
      return null;
    });
  return registration;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function getPushState(): Promise<PushState> {
  const permission: PermissionState = 'Notification' in window ? Notification.permission : 'unsupported';
  const pushSupported = 'PushManager' in window && 'serviceWorker' in navigator;
  const reg = pushSupported ? await registerServiceWorker() : null;
  const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return {
    permission,
    pushSupported: pushSupported && reg !== null,
    subscribed: subscription !== null && permission === 'granted',
    endpoint: permission === 'granted' ? (subscription?.endpoint ?? null) : null,
    needsInstall: isIos && !isStandalone && !oldIos,
    oldIos,
  };
}

/** Must run from a click: browsers only show the permission prompt in response to user action. */
export async function enableNotifications(): Promise<PushState> {
  if (!('Notification' in window)) return getPushState();
  const permission = await Notification.requestPermission();
  if (permission === 'granted') await subscribeThisDevice();
  return getPushState();
}

async function subscribeThisDevice() {
  const reg = await registerServiceWorker();
  if (!reg || !('PushManager' in window)) return;
  const subscribe = async () => {
    const { vapidPublicKey } = await api.config();
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidPublicKey) });
  };
  const subscription = (await reg.pushManager.getSubscription()) ?? (await subscribe());
  try {
    await api.subscribePush(subscription.toJSON());
  } catch (error) {
    // Another account holds this endpoint under other keys: a new subscription gets a new endpoint.
    if (!(error instanceof ApiError && error.code === 'endpoint_taken')) throw error;
    await subscription.unsubscribe();
    await api.subscribePush((await subscribe()).toJSON());
  }
}

/**
 * Called after sign-in. If this browser already allowed notifications, make sure its subscription
 * belongs to the account now signed in.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    await subscribeThisDevice();
  } catch (error) {
    console.warn('Could not sync the push subscription', error);
  }
}

export async function disablePushHere(): Promise<PushState> {
  const reg = await registerServiceWorker();
  const subscription = reg ? await reg.pushManager.getSubscription() : null;
  if (subscription) {
    await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return getPushState();
}

/** Drops this browser's subscription from the server so the next account here starts clean. */
export async function forgetPushOnServer(): Promise<void> {
  const reg = await registerServiceWorker();
  const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  if (subscription) await api.unsubscribePush(subscription.endpoint).catch(() => undefined);
}

/** What a click on a notification opens: a chat, or a page such as a pull request on GitHub. */
export type NotificationTarget = { conversationId: number } | { url: string };

/** For browsers without Web Push: show the notification from the page while the tab is open. */
export async function showLocalNotification(title: string, body: string, tag: string, urgent: boolean, target: NotificationTarget) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await registerServiceWorker();
  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    tag,
    renotify: true,
    requireInteraction: urgent,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: target,
  };
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);
}
