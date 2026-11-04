import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import {
  createIdentity,
  encryptMessage,
  importIdentity,
  newChatKeyBytes,
  newKeyId,
  wrapChatKey,
  type Identity,
  type IdentitySecrets,
} from '../shared/e2ee.ts';
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
  agent: false,
  busy: false,
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
    const wrapped = await wrapChatKey(newChatKeyBytes(), { id: OTHER, identity: swapped }, { id: ME, dh: mine.publicKeys.dh }, keyId);
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
