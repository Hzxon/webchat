import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { Logger } from './config.js';

/**
 * Sends notifications to Apple's push service. Every request is signed with a provider token: a
 * JWT from the provider's key, which Apple takes for an hour and refuses to see refreshed more
 * often than every 20 minutes. Server instances share one token through the database, so a
 * burst of cold starts never looks like a refresh storm.
 */

export interface ApnsOptions {
  /** https://api.push.apple.com, or a fake in tests. Apple only speaks HTTP/2. */
  origin: string;
  /** The provider's key: a P-256 key as PKCS#8 PEM, its id, and the team id it belongs to. */
  privateKey: string;
  keyId: string;
  teamId: string;
  logger: Logger;
}

export interface ApnsNotification {
  deviceToken: string;
  /** The app's bundle id. */
  topic: string;
  /** How long the push waits for an offline device. */
  ttlSeconds: number;
  /** A newer push with the same id replaces the earlier one. At most 64 bytes. */
  collapseId: string;
  payload: unknown;
}

/** Status 200 is delivered. Otherwise the reason Apple gave, or what went wrong before Apple answered. */
export interface ApnsResult {
  status: number;
  reason: string | null;
}

/** Where the shared provider token lives. */
export interface TokenStore {
  getMeta(key: string): Promise<string | null>;
  setMetaIf(key: string, expected: string | null, value: string): Promise<boolean>;
}

interface ProviderToken {
  token: string;
  issuedAt: number;
}

const TOKEN_KEY = 'apns_provider_token';
/** Under Apple's hour, with room for the clock of the instance that minted it. */
const TOKEN_MAX_AGE_MS = 50 * 60_000;
const TIMEOUT_MS = 10_000;

export type Apns = ReturnType<typeof createApns>;

export function createApns(store: TokenStore, options: ApnsOptions) {
  const key = crypto.createPrivateKey(options.privateKey);
  let cached: ProviderToken | null = null;

  const fresh = (token: ProviderToken) => Date.now() - token.issuedAt < TOKEN_MAX_AGE_MS;

  function mint(): ProviderToken {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: options.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: options.teamId, iat: issuedAt })).toString('base64url');
    // JWT wants the raw r and s values, not the DER form that sign() gives by default.
    const signature = crypto
      .sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return { token: `${header}.${claims}.${signature}`, issuedAt: issuedAt * 1000 };
  }

  /**
   * The shared token. A new one is stored under a compare-and-set, so when two instances find it
   * stale at once, one mints and the other takes that one. `rejected` is a token Apple just
   * called expired: anything newer will do, that one will not.
   */
  async function providerToken(rejected?: string): Promise<string> {
    if (cached && cached.token !== rejected && fresh(cached)) return cached.token;
    const stored = await store.getMeta(TOKEN_KEY);
    const parsed = stored ? (JSON.parse(stored) as ProviderToken) : null;
    if (parsed && parsed.token !== rejected && fresh(parsed)) {
      cached = parsed;
      return parsed.token;
    }
    const next = mint();
    if (await store.setMetaIf(TOKEN_KEY, stored, JSON.stringify(next))) {
      cached = next;
      return next.token;
    }
    const latest = await store.getMeta(TOKEN_KEY);
    cached = latest ? (JSON.parse(latest) as ProviderToken) : next;
    return cached.token;
  }

  /** One HTTP/2 connection per push. A serverless instance cannot keep Apple's long-lived connection anyway. */
  function post(token: string, notification: ApnsNotification, body: string): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let done = false;
      const session = http2.connect(options.origin);
      const finish = (result: ApnsResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!session.destroyed) session.close();
        resolve(result);
      };
      const timer = setTimeout(() => {
        session.destroy();
        finish({ status: 0, reason: 'Timed out' });
      }, TIMEOUT_MS);
      session.on('error', (error: Error) => finish({ status: 0, reason: error.message }));

      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${notification.deviceToken}`,
        authorization: `bearer ${token}`,
        'apns-topic': notification.topic,
        'apns-push-type': 'alert',
        // 10 asks the push service to wake the device now instead of batching for battery.
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + notification.ttlSeconds),
        'apns-collapse-id': notification.collapseId,
        'content-type': 'application/json',
      });
      let status = 0;
      const chunks: Buffer[] = [];
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let reason: string | null = text || null;
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
        } catch {
          // Apple answers with JSON; anything else is reported as it came.
        }
        finish({ status, reason: status === 200 ? null : reason });
      });
      stream.on('error', (error: Error) => finish({ status: 0, reason: error.message }));
      stream.end(body);
    });
  }

  async function send(notification: ApnsNotification): Promise<ApnsResult> {
    const body = JSON.stringify(notification.payload);
    const token = await providerToken();
    const result = await post(token, notification, body);
    if (result.status === 403 && result.reason === 'ExpiredProviderToken') {
      return post(await providerToken(token), notification, body);
    }
    return result;
  }

  return { send };
}
