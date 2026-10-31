// The page's side of end-to-end encryption: holds the unlocked account keys, opens chat keys,
// and turns server messages into readable text.
import {
  createIdentity,
  decryptMessage,
  encryptMessage,
  importChatKey,
  importIdentity,
  keyFingerprint,
  newChatKeyBytes,
  newKeyId,
  unwrapChatKey,
  wrapChatKey,
  type Identity,
  type IdentitySecrets,
} from '../../../shared/e2ee';
import type {
  ChatKeyInput,
  ConversationDTO,
  EnvelopeDTO,
  MessageDTO,
  PublicKeysDTO,
  UserDTO,
} from '../../../shared/types';
import { keystore } from './keystore';

/** A message as the page shows it: the server's copy plus its readable text. */
export interface ChatMessage extends MessageDTO {
  text: string;
  /** "plain" for messages from before encryption; "failed" if decryption or the signature check failed. */
  security: 'encrypted' | 'plain' | 'failed';
}

export interface ChatConversation extends Omit<ConversationDTO, 'lastMessage'> {
  lastMessage: ChatMessage | null;
}

/** Looks up a person's public keys: the server's list for others, the unlocked keys for oneself. */
export type KeyLookup = (userId: number) => PublicKeysDTO | null;

export class EncryptionUnavailableError extends Error {}

let me: { id: number; identity: Identity } | null = null;
const chatKeys = new Map<string, Promise<CryptoKey>>();
const opened = new Map<number, { text: string; security: 'encrypted' }>();
let pins: Record<number, string> | null = null;

const chatKeyName = (conversationId: number, keyId: string) => `${conversationId}:${keyId}`;

export const keyring = {
  myKeys: (): PublicKeysDTO => me!.identity.publicKeys,

  /** Loads this device's keys for the user. False means the user must unlock with their password. */
  async load(userId: number): Promise<boolean> {
    const stored = await keystore.getIdentity().catch(() => undefined);
    if (!stored || stored.userId !== userId) return false;
    me = { id: userId, identity: stored.identity };
    return true;
  },

  /** Keeps freshly opened or created account keys on this device. */
  async adopt(userId: number, secrets: IdentitySecrets) {
    const identity = await importIdentity(secrets);
    await keystore.clear();
    await keystore.setIdentity({ userId, identity });
    me = { id: userId, identity };
    pins = null;
  },

  createSecrets: () => createIdentity(),

  /** Drops every key from memory and from this device. */
  async forget() {
    me = null;
    pins = null;
    chatKeys.clear();
    opened.clear();
    await keystore.clear().catch(() => undefined);
  },

  /**
   * Shares everyone's public keys with the service worker, and compares each person's keys with
   * the ones first seen on this device. Returns the people whose keys changed since.
   */
  async checkKeys(users: UserDTO[]): Promise<Set<number>> {
    const changed = new Set<number>();
    pins ??= (await keystore.getPins().catch(() => undefined)) ?? {};
    let pinned = false;
    const directory: Record<number, PublicKeysDTO> = { [me!.id]: me!.identity.publicKeys };
    for (const user of users) {
      if (!user.keys) continue;
      directory[user.id] = user.keys;
      const fingerprint = await keyFingerprint(user.keys);
      if (!pins[user.id]) {
        pins[user.id] = fingerprint;
        pinned = true;
      } else if (pins[user.id] !== fingerprint) {
        changed.add(user.id);
      }
    }
    await Promise.all([keystore.setDirectory(directory), pinned ? keystore.setPins(pins) : undefined]).catch(() => undefined);
    return changed;
  },

  /** Accepts a person's new keys after the user checked the security code with them. */
  async trust(user: UserDTO) {
    if (!user.keys) return;
    pins ??= (await keystore.getPins().catch(() => undefined)) ?? {};
    pins[user.id] = await keyFingerprint(user.keys);
    await keystore.setPins(pins);
  },

  /** Opens this user's copy of a chat key, after checking that a member of the chat created it. */
  chatKey(conversation: Pick<ConversationDTO, 'id' | 'keyId' | 'myKey' | 'members'>, keysOf: KeyLookup) {
    const { id, keyId, myKey } = conversation;
    if (!keyId || !myKey || !me) return null;
    const name = chatKeyName(id, keyId);
    let pending = chatKeys.get(name);
    if (!pending) {
      const self = me;
      pending = (async () => {
        const stored = await keystore.getChatKey(id, keyId).catch(() => undefined);
        if (stored) return stored;
        const wrapperKeys = keysOf(myKey.wrappedBy);
        if (!wrapperKeys || !conversation.members.some((m) => m.userId === myKey.wrappedBy)) {
          throw new Error('The chat key was not created by a member of this chat.');
        }
        const key = await unwrapChatKey(myKey, self, { id: myKey.wrappedBy, dh: wrapperKeys.dh }, keyId);
        await keystore.setChatKey(id, keyId, key).catch(() => undefined);
        return key;
      })();
      chatKeys.set(name, pending);
      pending.catch(() => chatKeys.delete(name));
    }
    return pending;
  },

  /** Makes a new chat key and wraps it for every member. Refuses members without keys or with changed keys. */
  async createChatKey(members: Array<{ id: number; name: string; keys: PublicKeysDTO | null }>, changed: Set<number>) {
    const missing = members.filter((m) => !m.keys).map((m) => m.name);
    if (missing.length) {
      throw new EncryptionUnavailableError(`${missing.join(', ')} must sign in again to turn on encryption.`);
    }
    const suspicious = members.filter((m) => changed.has(m.id)).map((m) => m.name);
    if (suspicious.length) {
      throw new EncryptionUnavailableError(`Check ${suspicious.join(', ')}'s security code first.`);
    }
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const wrappedKeys = await Promise.all(
      members.map(async (m) => ({ userId: m.id, ...(await wrapChatKey(raw, me!, { id: m.id, dh: m.keys!.dh }, keyId)) })),
    );
    const input: ChatKeyInput = { keyId, wrappedKeys };
    return { input, key: await importChatKey(raw) };
  },

  /** Keeps a chat key this device created, once the server has assigned the chat its id. */
  async remember(conversationId: number, keyId: string, key: CryptoKey) {
    chatKeys.set(chatKeyName(conversationId, keyId), Promise.resolve(key));
    await keystore.setChatKey(conversationId, keyId, key).catch(() => undefined);
  },

  async seal(chatKey: CryptoKey, keyId: string, meta: { conversationId: number; urgent: boolean; clientId: string }, text: string) {
    return encryptMessage(chatKey, keyId, me!.identity.signPrivate, { ...meta, senderId: me!.id }, text);
  },

  /** Remembers the text of a message this device just sent, so it never needs decrypting. */
  rememberText(messageId: number, text: string) {
    opened.set(messageId, { text, security: 'encrypted' });
  },

  /** Decrypts a message and checks its signature. Never throws: failures come back as "failed". */
  async open(message: MessageDTO, conversation: ChatConversation | ConversationDTO, keysOf: KeyLookup): Promise<ChatMessage> {
    if (!message.envelope) return { ...message, text: message.body, security: 'plain' };
    const known = opened.get(message.id);
    if (known) return { ...message, ...known };
    try {
      const text = await decrypt(message, message.envelope, conversation, keysOf);
      const result = { text, security: 'encrypted' as const };
      if (message.id > 0) opened.set(message.id, result);
      return { ...message, ...result };
    } catch {
      return { ...message, text: '', security: 'failed' };
    }
  },
};

async function decrypt(message: MessageDTO, envelope: EnvelopeDTO, conversation: ChatConversation | ConversationDTO, keysOf: KeyLookup) {
  if (envelope.kid !== conversation.keyId) throw new Error('Encrypted with a key this chat does not use.');
  const key = await keyring.chatKey(conversation, keysOf);
  const senderKeys = keysOf(message.senderId);
  if (!key || !senderKeys) throw new Error('Missing keys.');
  return decryptMessage(
    key,
    senderKeys.sign,
    { conversationId: message.conversationId, senderId: message.senderId, urgent: message.urgent, clientId: message.clientId ?? '' },
    envelope,
  );
}
