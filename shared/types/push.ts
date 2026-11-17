import { type EnvelopeDTO } from './chat.js';

/** A phone's Bark app that registered through the user's link. The key is what Bark shows for the device. */
export interface BarkDeviceDTO {
  key: string;
  registeredAt: number;
  seenAt: number;
}

/**
 * The user's Bark setup (R-018): the server URL to type into the app, the encryption key, and the
 * phones that registered. Alerts to Bark carry chat and sender names, never the message text.
 */
export interface BarkDTO {
  /** False until the server holds Bark's APNs key, BARK_APNS_KEY. */
  configured: boolean;
  link: {
    serverUrl: string;
    /** 32 characters for AES-256-GCM, typed into Bark's Push Encryption settings. Null while alerts go plain. */
    cipherKey: string | null;
    devices: BarkDeviceDTO[];
  } | null;
}

/** JSON body of every Web Push message. The service worker turns it into a notification. */
export interface PushPayload {
  /** "reaction" and "sync" only wake a tab the user is looking at; "project" and "group" say someone added them to one. */
  kind: 'message' | 'reaction' | 'sync' | 'project' | 'group' | 'github' | 'test';
  title: string;
  /** Text for messages the server can read (tests, old plain messages). Empty for encrypted ones. */
  body: string;
  /** Shown before the decrypted text, such as "Bob: " in a group. */
  bodyPrefix: string;
  urgent: boolean;
  tag: string;
  conversationId: number | null;
  messageId: number | null;
  senderId: number | null;
  clientId: string | null;
  /** The encrypted message, when it fits in a push. The service worker decrypts it on the device. */
  envelope: EnvelopeDTO | null;
  unreadTotal: number | null;
  sentAt: number;
  /** Page a click on the notification opens instead of a chat, such as a pull request on GitHub. */
  url: string | null;
}

/** Messages the service worker posts to open pages. */
export type WorkerToPageMessage =
  | { type: 'push'; payload: PushPayload }
  | { type: 'open-conversation'; conversationId: number }
  | { type: 'subscription-changed' };

/**
 * True for Apple's push service, which Safari and web apps on iPhone and iPad use. WebKit revokes a
 * subscription after a few pushes that show no notification, so such an endpoint never gets a push
 * that only wakes an open tab (D-047).
 */
export function showsEveryPush(endpoint: string | null): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(endpoint).hostname;
    return host === 'push.apple.com' || host.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}
