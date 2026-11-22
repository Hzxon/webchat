import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import {
  createIdentity,
  encryptMessage,
  fromBase64Url,
  importChatKey,
  importIdentity,
  linkChatKey,
  newChatKeyBytes,
  newKeyId,
  toBase64Url,
  wrapChatKey,
  type Identity,
  type IdentitySecrets,
} from '../shared/e2ee.ts';
import { OldKeyCopyError, Keyring as SharedKeyring } from '../shared/keyring.ts';
import type { ConversationDTO, MessageDTO, PublicKeysDTO, UserDTO } from '../shared/types.ts';

// The keyring keeps keys in IndexedDB, which Node lacks. This stands in for the little of it that
// client/src/e2ee/keystore.ts uses: one store, and the key ranges that clearKeys deletes.
const rows = new Map<string, unknown>();
type Range = { includes: (key: string) => boolean };
const isRange = (key: unknown): key is Range => typeof key === 'object' && key !== null && 'includes' in key;
const fakeDatabase = {
  onversionchange: null,
  transaction() {
    const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
      objectStore: () => ({
        get: (key: string) => done(rows.get(key)),
        put: (value: unknown, key: string) => done(rows.set(key, value) && key),
        delete: (key: string | Range) => {
          for (const k of [...rows.keys()]) if (isRange(key) ? key.includes(k) : k === key) rows.delete(k);
          return done(undefined);
        },
      }),
    };
    // keystore sets oncomplete after it makes the request, so complete on the next tick.
    const done = (result: unknown) => {
      queueMicrotask(() => tx.oncomplete?.());
      return { result };
    };
    return tx;
  },
};
Object.assign(globalThis, {
  indexedDB: {
    open() {
      const request: { result: typeof fakeDatabase; onsuccess?: () => void } = { result: fakeDatabase };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  },
  IDBKeyRange: {
    upperBound: (bound: string, open: boolean): Range => ({ includes: (k) => (open ? k < bound : k <= bound) }),
    lowerBound: (bound: string, open: boolean): Range => ({ includes: (k) => (open ? k > bound : k >= bound) }),
  },
});

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientKeyring = '../client/src/e2ee/keyring.ts';

type KeyLookup = (userId: number) => PublicKeysDTO | null;
type Conversation = Pick<ConversationDTO, 'id' | 'keyId' | 'myKey' | 'members' | 'keyLinks'>;
interface Keyring {
  adopt: (userId: number, secrets: IdentitySecrets) => Promise<void>;
  checkKeys: (users: UserDTO[]) => Promise<Set<number>>;
  trust: (user: UserDTO) => Promise<void>;
  verify: (user: UserDTO) => Promise<void>;
  verifiedOf: (users: UserDTO[]) => Promise<Set<number>>;
  forget: () => Promise<void>;
  chatKey: (conversation: Conversation, keysOf: KeyLookup) => Promise<CryptoKey> | null;
  remember: (conversationId: number, keyId: string, key: CryptoKey) => Promise<void>;
  open: (message: MessageDTO, conversation: ConversationDTO, keysOf: KeyLookup) => Promise<Opened>;
  reopen: (conversations: Record<number, ConversationDTO>, keysOf: KeyLookup) => Promise<Opened[]>;
}
type Opened = MessageDTO & { text: string; security: string; reaction: { messageId: number; emoji: string } | null };

const ME = 1;
const OTHER = 2;
const CHAT = 10;

const user = (id: number, keys: PublicKeysDTO): UserDTO => ({
  id,
  username: `user${id}`,
  displayName: `User ${id}`,
  online: false,
  lastSeen: null,
  keys,
  agentOwner: null,
  protocol: 0,
  agentRepos: [],
  deleted: false,
});

const member = (userId: number) => ({ userId, lastDeliveredId: 0, lastReadId: 0 });

describe('The keyring in client/src/e2ee/keyring.ts, after a key change nobody checked (D-018)', () => {
  let keyring: Keyring;
  let EncryptionUnavailableError: new (...args: never[]) => Error;
  let mine: IdentitySecrets;
  let real: Identity;
  let swapped: Identity;

  before(async () => {
    const mod = await import(clientKeyring);
    keyring = mod.keyring;
    EncryptionUnavailableError = mod.EncryptionUnavailableError;
    mine = await createIdentity();
    real = await importIdentity(await createIdentity());
    swapped = await importIdentity(await createIdentity());
  });

  // Each test starts on a device that pinned the other person's real keys, and then sees the server
  // list keys that it swapped in.
  let keysOf: KeyLookup;
  beforeEach(async () => {
    rows.clear();
    await keyring.adopt(ME, mine);
    assert.deepEqual(await keyring.checkKeys([user(OTHER, real.publicKeys)]), new Set());
    assert.deepEqual(await keyring.checkKeys([user(OTHER, swapped.publicKeys)]), new Set([OTHER]));
    keysOf = (id) => (id === ME ? mine.publicKeys : swapped.publicKeys);
  });

  /** A chat whose new key the swapped keys wrapped for this user, as a server holding them could. */
  async function keyedBySwappedKeys(): Promise<ConversationDTO> {
    const keyId = newKeyId();
    const wrapped = await wrapChatKey(newChatKeyBytes(), { id: OTHER, identity: swapped }, { id: ME, dh: mine.publicKeys.dh }, keyId, CHAT);
    return {
      id: CHAT,
      keyId,
      myKey: { wrappedBy: OTHER, ...wrapped },
      members: [member(ME), member(OTHER)],
      keyLinks: [],
    } as unknown as ConversationDTO;
  }

  /**
   * A message in the other person's name, and their reaction to it, signed with the given keys,
   * under a key this device holds.
   */
  async function signedBy(identity: Identity): Promise<{ message: MessageDTO; reaction: MessageDTO; conversation: ConversationDTO }> {
    const keyId = newKeyId();
    const raw = newChatKeyBytes();
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await keyring.remember(CHAT, keyId, key);
    const meta = { conversationId: CHAT, senderId: OTHER, urgent: false, clientId: 'c1', kind: 'message' as const };
    const envelope = await encryptMessage(key, keyId, identity.signPrivate, meta, 'hello');
    const message = { id: 5, body: '', envelope, createdAt: 0, ...meta } as MessageDTO;
    const reactionMeta = { ...meta, clientId: 'c2', kind: 'reaction' as const };
    const content = { text: '', reaction: { messageId: 5, emoji: '👍' } };
    const reactionEnvelope = await encryptMessage(key, keyId, identity.signPrivate, reactionMeta, content);
    const reaction = { id: 6, body: '', envelope: reactionEnvelope, createdAt: 0, ...reactionMeta } as MessageDTO;
    // keyring.remember already holds the key, so the wrapped copy is never opened.
    const myKey = { wrappedBy: ME, iv: '', data: '' };
    const conversation = { id: CHAT, keyId, myKey, members: [member(ME), member(OTHER)], keyLinks: [] } as unknown as ConversationDTO;
    return { message, reaction, conversation };
  }

  test('refuses to open a chat key that the changed keys wrapped, so nothing is sent under it', async () => {
    const conversation = await keyedBySwappedKeys();
    await assert.rejects(keyring.chatKey(conversation, keysOf)!, EncryptionUnavailableError);
  });

  test('shows a message signed with the changed keys as failed, not as encrypted', async () => {
    const { message, conversation } = await signedBy(swapped);
    const opened = await keyring.open(message, conversation, keysOf);
    assert.equal(opened.security, 'failed');
    assert.equal(opened.text, '');
  });

  test('leaves the changed keys out of the service worker directory', async () => {
    const directory = rows.get('directory') as Record<number, PublicKeysDTO>;
    assert.equal(directory[OTHER], undefined);
    assert.deepEqual(directory[ME], mine.publicKeys);
  });

  test('once the user checks the security code, the new keys work again', async () => {
    await keyring.trust(user(OTHER, swapped.publicKeys));
    assert.deepEqual(await keyring.checkKeys([user(OTHER, swapped.publicKeys)]), new Set());
    assert.ok(await keyring.chatKey(await keyedBySwappedKeys(), keysOf));
    const { message, conversation } = await signedBy(swapped);
    const opened = await keyring.open(message, conversation, keysOf);
    assert.equal(opened.security, 'encrypted');
    assert.equal(opened.text, 'hello');
  });

  test('keeps a person verified only while their keys are the ones the user compared', async () => {
    assert.deepEqual(await keyring.verifiedOf([user(OTHER, real.publicKeys)]), new Set());
    await keyring.verify(user(OTHER, real.publicKeys));
    assert.deepEqual(await keyring.verifiedOf([user(OTHER, real.publicKeys)]), new Set([OTHER]));
    assert.deepEqual(await keyring.verifiedOf([user(OTHER, swapped.publicKeys)]), new Set());
  });

  test('forgets whom the user verified when the account leaves the device', async () => {
    await keyring.verify(user(OTHER, real.publicKeys));
    await keyring.forget();
    await keyring.adopt(ME, mine);
    assert.deepEqual(await keyring.verifiedOf([user(OTHER, real.publicKeys)]), new Set());
  });

  test('opens nothing it held back while the code is still unchecked', async () => {
    const { message, reaction, conversation } = await signedBy(swapped);
    assert.equal((await keyring.open(message, conversation, keysOf)).security, 'failed');
    assert.equal((await keyring.open(reaction, conversation, keysOf)).security, 'failed');
    assert.deepEqual(await keyring.reopen({ [CHAT]: conversation }, keysOf), []);
  });

  test('opens the messages and reactions it held back once the user checks the code (K-26)', async () => {
    const { message, reaction, conversation } = await signedBy(swapped);
    await keyring.open(message, conversation, keysOf);
    await keyring.open(reaction, conversation, keysOf);
    await keyring.trust(user(OTHER, swapped.publicKeys));
    await keyring.checkKeys([user(OTHER, swapped.publicKeys)]);
    const reopened = await keyring.reopen({ [CHAT]: conversation }, keysOf);
    assert.deepEqual(
      reopened.map((m) => [m.id, m.security, m.text, m.reaction?.emoji]).sort(),
      [
        [5, 'encrypted', 'hello', undefined],
        [6, 'encrypted', '', '👍'],
      ],
    );
    assert.deepEqual(await keyring.reopen({ [CHAT]: conversation }, keysOf), []);
  });
});

describe('The key checks in shared/keyring.ts, which the page and the agent share (K-40)', () => {
  let ring: SharedKeyring;
  let other: Identity;
  let keysOf: KeyLookup;
  // A chat whose key `newer` replaced `older`, linked as a removal leaves it (D-044).
  const older = newKeyId();
  const newer = newKeyId();
  const olderRaw = newChatKeyBytes();
  let chat: ConversationDTO;
  let link: ConversationDTO['keyLinks'][number];

  before(async () => {
    const mine = await importIdentity(await createIdentity());
    other = await importIdentity(await createIdentity());
    ring = new SharedKeyring({ id: ME, identity: mine }, {}, () => {});
    keysOf = (id) => (id === ME ? mine.publicKeys : other.publicKeys);
    const newerRaw = newChatKeyBytes();
    const wrapped = await wrapChatKey(newerRaw, { id: OTHER, identity: other }, { id: ME, dh: mine.publicKeys.dh }, newer, CHAT);
    link = { keyId: newer, previousKeyId: older, ...(await linkChatKey(await importChatKey(newerRaw), newer, CHAT, olderRaw, older)) };
    chat = { id: CHAT, keyId: newer, myKey: { wrappedBy: OTHER, ...wrapped }, members: [member(ME), member(OTHER)], keyLinks: [link] } as unknown as ConversationDTO;
  });

  test('opens an earlier key through the link in the key that replaced it', async () => {
    const key = (await ring.keyFor(chat, older, keysOf))!;
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importChatKey(olderRaw), new Uint8Array([7]));
    assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)), new Uint8Array([7]));
  });

  test('never hands out a replaced key as current, even when the server names it so', () => {
    assert.equal(ring.chatKey({ ...chat, keyId: older }, keysOf), null);
  });

  test('refuses a chain of links the server looped, instead of waiting on it forever', () => {
    const looped = { ...chat, id: CHAT + 1, keyId: newKeyId(), keyLinks: [link, { ...link, keyId: older, previousKeyId: newer }] };
    assert.equal(ring.keyFor(looped, older, keysOf), null);
  });

  test('seals with a key whose copy names its chat', async () => {
    assert.ok(await ring.sealingKey(chat, keysOf));
  });

  test('never seals with a key whose copy names no chat, which the server could take from another chat (K-65)', async () => {
    // What wrapChatKey made before D-111: the pair key's info named only the two people.
    const keyId = newKeyId();
    const raw = newChatKeyBytes();
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await crypto.subtle.importKey('raw', fromBase64Url(ring.self.identity.publicKeys.dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, other.dhPrivate, 256);
    const pair = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(keyId), info: new TextEncoder().encode(`webchat/chat-key/v1|from:${OTHER}|to:${ME}`) },
      await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(keyId) }, pair, raw);
    const old = { ...chat, id: CHAT + 2, keyId, myKey: { wrappedBy: OTHER, iv: toBase64Url(iv), data: toBase64Url(data) }, keyLinks: [] };
    await assert.rejects(ring.sealingKey(old, keysOf), OldKeyCopyError);
    assert.ok(await ring.keyFor(old, keyId, keysOf), 'it still opens what was sealed with it');
  });
});

describe('The keyring in client/src/e2ee/keyring.ts, when the server drops a key link (K-43)', () => {
  let keyring: Keyring & { load: (userId: number) => Promise<boolean> };
  const OLD = newKeyId();
  const NEW = newKeyId();

  before(async () => {
    keyring = (await import(clientKeyring)).keyring;
    rows.clear();
    await keyring.adopt(ME, await createIdentity());
    const key = await crypto.subtle.importKey('raw', newChatKeyBytes(), 'AES-GCM', false, ['encrypt', 'decrypt']);
    await keyring.remember(CHAT, OLD, key);
    await keyring.remember(CHAT, NEW, key);
  });

  // The device holds both keys, so neither wrapped copy is opened.
  const chat = (keyId: string, keyLinks: unknown[]) =>
    ({ id: CHAT, keyId, myKey: { wrappedBy: ME, iv: '', data: '' }, members: [member(ME)], keyLinks }) as unknown as Conversation;
  const keysOf: KeyLookup = () => null;

  test('never seals again with a key it saw replaced, though the server names it current with no link', async () => {
    assert.ok(await keyring.chatKey(chat(NEW, [{ keyId: NEW, previousKeyId: OLD, iv: '', data: '' }]), keysOf));
    assert.equal(keyring.chatKey(chat(OLD, []), keysOf), null);
  });

  test('remembers the replaced key after the page loads again', async () => {
    assert.equal(await keyring.load(ME), true);
    assert.equal(keyring.chatKey(chat(OLD, []), keysOf), null);
  });
});
