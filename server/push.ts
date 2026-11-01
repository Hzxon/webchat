import webpush from 'web-push';
import type { Bark } from './bark.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { PushPayload } from '../shared/types.js';

// The server only POSTs to browser push services. Without this list, any signed-in user could
// register an internal URL as an "endpoint" and make the server send requests to it.
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Brave, Opera, Samsung Internet
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari on macOS and iOS
  'notify.windows.com', // Edge on Windows
];

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type Push = Awaited<ReturnType<typeof createPush>>;

export async function createPush(db: Db, config: Config, bark: Bark) {
  // Keys from the environment win. Otherwise the first server to start generates a pair and saves
  // it as one value, so every instance signs pushes with the same keys.
  const { publicKey, privateKey } =
    config.vapidPublicKey && config.vapidPrivateKey
      ? { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey }
      : (JSON.parse(await db.claimMeta('vapid_keys', JSON.stringify(webpush.generateVAPIDKeys()))) as {
          publicKey: string;
          privateKey: string;
        });
  webpush.setVapidDetails(config.vapidSubject, publicKey, privateKey);

  function isAllowedEndpoint(endpoint: string): boolean {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    if (config.extraPushHosts.includes(url.host)) return true;
    return (
      url.protocol === 'https:' &&
      PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  }

  /**
   * Sends one payload to the browsers the user enabled push on: all of them, or only the one with
   * the given endpoint. Dead subscriptions are deleted. Without an endpoint, the user is not
   * looking at the app anywhere, so the phones they linked through Bark get the alert too (R-018).
   */
  async function sendToUser(
    userId: number,
    payload: PushPayload,
    onlyEndpoint?: string,
  ): Promise<{ sent: number; failed: number }> {
    const all = await db.pushSubscriptionsFor(userId);
    const subscriptions = onlyEndpoint ? all.filter((s) => s.endpoint === onlyEndpoint) : all;
    const phones = onlyEndpoint ? Promise.resolve({ sent: 0, failed: 0 }) : bark.sendToUser(userId, payload);
    const body = JSON.stringify(payload);
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        // web-push encrypts and signs the request; fetch sends it. web-push's own sender only
        // speaks HTTPS, which would rule out a local fake push service in tests.
        const request = webpush.generateRequestDetails(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          body,
          {
            // Urgent messages wait up to 3 days for an offline device; normal ones expire after 1 day.
            TTL: payload.urgent ? 3 * 24 * 3600 : 24 * 3600,
            // "high" asks the push service to wake the device now instead of batching for battery.
            urgency: 'high',
          },
        );
        try {
          const response = await fetch(request.endpoint, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            body: request.body,
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return true;
          if (response.status === 404 || response.status === 410) {
            await db.deletePushSubscription(subscription.endpoint);
          } else {
            const detail = (await response.text()).slice(0, 200);
            config.logger.warn(`Push to user ${userId} failed (${response.status}): ${detail}`);
          }
        } catch (error) {
          config.logger.warn(`Push to user ${userId} failed (network error): ${String(error)}`);
        }
        return false;
      }),
    );
    const viaBark = await phones;
    const sent = results.filter(Boolean).length + viaBark.sent;
    return { sent, failed: results.length - results.filter(Boolean).length + viaBark.failed };
  }

  return { publicKey, isAllowedEndpoint, sendToUser };
}
