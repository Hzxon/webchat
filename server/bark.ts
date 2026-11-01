import crypto from 'node:crypto';
import { randomBytes, toBase64Url } from '../shared/e2ee.js';
import type { PushPayload } from '../shared/types.js';
import { createApns } from './apns.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

/**
 * Alerts for iPhones without Web Push, through the Bark app (R-018). WebChat stands in for Bark's
 * server: the app registers its APNs token here, and the server pushes to it through Apple with
 * the key Bark's author publishes. The alert carries what a Web Push's title and prefix carry,
 * chat and sender names, never the message text, which the server does not have.
 */

/** The Bark app's bundle id. Every push to it names this topic, whichever server sends it. */
export const BARK_TOPIC = 'me.fin.bark';
/** A Bark key the person may have to type: no characters that look alike. */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** AES-256-GCM, as the sample code in Bark's encryption settings makes it. */
const CIPHER_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const IV_ALPHABET = '0123456789abcdef';
/** Apple takes 4 KB; an alert is far below that, but a runaway title must never reach it. */
const MAX_PAYLOAD_BYTES = 3000;

export type Bark = ReturnType<typeof createBark>;

/** The secret in the server URL the Bark app calls: 32 random bytes. */
export const newLinkToken = () => toBase64Url(randomBytes(32));
/** What Bark shows for a registered phone. */
export const newDeviceKey = () => toBase64Url(randomBytes(16));

export function newCipherKey(): string {
  let key = '';
  for (let i = 0; i < CIPHER_KEY_LENGTH; i++) key += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return key;
}

function randomIv(): string {
  let iv = '';
  for (let i = 0; i < IV_LENGTH; i++) iv += IV_ALPHABET[crypto.randomInt(IV_ALPHABET.length)];
  return iv;
}

/**
 * What the phone shows, in Bark's own parameter names. The body is the preview a Web Push shows
 * before decrypting: the server-readable text of a card or a test, else "New message".
 */
export function barkFields(payload: PushPayload, origin: string): Record<string, string> {
  const fields: Record<string, string> = {
    title: payload.title,
    body: payload.bodyPrefix + (payload.body || (payload.urgent ? 'Urgent message. Open the chat to read it.' : 'New message')),
    // Bark stacks alerts with the same group, one stack per chat.
    group: payload.conversationId === null ? payload.tag : `chat-${payload.conversationId}`,
    // Opened by a tap: the chat, or the page an alert names, such as a pull request on GitHub.
    url: payload.url ?? (payload.conversationId === null ? origin : `${origin}/?chat=${payload.conversationId}`),
    sound: payload.urgent ? 'alarm.caf' : '1107.caf',
    // Time-sensitive alerts get through Focus; "call" makes Bark ring for 30 seconds.
    level: payload.urgent ? 'timeSensitive' : 'active',
  };
  if (payload.urgent) fields.call = '1';
  if (payload.unreadTotal !== null) fields.badge = String(payload.unreadTotal);
  return fields;
}

/**
 * The payload as Bark's notification extension reads it: the alert under "aps", every other
 * field at the top level. With a cipher key, everything goes inside "ciphertext" instead, and
 * Apple sees only the placeholder, which Bark replaces after decrypting on the phone.
 */
export function barkPayload(fields: Record<string, string>, cipherKey: string | null): Record<string, unknown> {
  const aps: Record<string, unknown> = { 'mutable-content': 1, category: 'myNotificationCategory' };
  if (cipherKey === null) {
    const { title, body, sound, group, ...rest } = fields;
    return { aps: { ...aps, alert: { title, body }, sound, 'thread-id': group }, group, ...rest };
  }
  const iv = randomIv();
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(cipherKey, 'utf8'), Buffer.from(iv, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    aps: { ...aps, alert: { title: 'WebChat', body: 'New message' }, sound: '1107.caf' },
    ciphertext: encrypted.toString('base64'),
    iv,
  };
}

/** The collapse id Apple sees, with nothing of the chat in it. */
const collapseIdFor = (tag: string) => crypto.createHash('sha256').update(tag).digest('base64url').slice(0, 22);

export function createBark(db: Db, config: Config) {
  const apns = config.barkApnsKey
    ? createApns(db, {
        origin: config.apnsOrigin,
        privateKey: config.barkApnsKey,
        keyId: config.barkApnsKeyId,
        teamId: config.barkApnsTeamId,
        logger: config.logger,
      })
    : null;

  /**
   * Sends the alert to every Bark install the user linked. A phone that Apple no longer knows is
   * forgotten, as a dead push subscription is. Reactions never alert, as with Web Push.
   */
  async function sendToUser(userId: number, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    const none = { sent: 0, failed: 0 };
    if (!apns || payload.kind === 'reaction') return none;
    const link = await db.barkLinkFor(userId);
    if (!link) return none;
    const devices = await db.barkDevicesFor(userId);
    if (devices.length === 0) return none;

    const fields = barkFields(payload, link.origin);
    let body = barkPayload(fields, link.cipher_key);
    if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_PAYLOAD_BYTES) {
      body = barkPayload({ ...fields, title: fields.title.slice(0, 100), body: 'New message' }, link.cipher_key);
    }
    const results = await Promise.all(
      devices.map(async (device) => {
        const result = await apns.send({
          deviceToken: device.device_token,
          topic: BARK_TOPIC,
          // Urgent messages wait up to 3 days for an offline phone; normal ones expire after 1 day.
          ttlSeconds: payload.urgent ? 3 * 24 * 3600 : 24 * 3600,
          collapseId: collapseIdFor(payload.tag),
          payload: body,
        });
        if (result.status === 200) return true;
        if (result.status === 410 || result.reason === 'BadDeviceToken') {
          await db.deleteBarkDevice(device.device_key);
        } else {
          config.logger.warn(`Bark alert to user ${userId} failed (${result.status}): ${result.reason ?? ''}`);
        }
        return false;
      }),
    );
    const sent = results.filter(Boolean).length;
    return { sent, failed: results.length - sent };
  }

  return { configured: apns !== null, sendToUser };
}
