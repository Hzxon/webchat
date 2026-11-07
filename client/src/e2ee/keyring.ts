// The page's side of end-to-end encryption: holds the unlocked account keys, opens chat keys,
// and turns server messages into readable text.
import {
  createIdentity,
  decryptContent,
  decryptDoc,
  encryptDoc,
  encryptMessage,
  importChatKey,
  importIdentity,
  keyFingerprint,
  linkChatKey,
  newChatKeyBytes,
  newKeyId,
  openChatKeyBytes,
  wrapChatKey,
  type DocContent,
  type DocMeta,
  type IdentitySecrets,
  type MessageContent,
  type QuotedMessage,
} from '../../../shared/e2ee';
import { describeGithubCard, readGithubCard } from '../../../shared/github';
import { EncryptionUnavailableError, Keyring, WRAPPER_CHANGED, type ChatKeyStore, type KeyedConversation, type KeyLookup } from '../../../shared/keyring';
import type {
  ChatKeyInput,
  ConversationDTO,
  DocDTO,
  DocRevisionDTO,
  EnvelopeDTO,
  GithubCardDTO,
  MessageDTO,
  MessageKind,
  PromptDTO,
  PublicKeysDTO,
  PullCardDTO,
  RotatedKeyInput,
  RunDTO,
  UserDTO,
  WrappedKeyInput,
} from '../../../shared/types';
import { keystore } from './keystore';

/** What decrypting a message gives the page. */
interface Opened {
  text: string;
  /** The message this one replies to, as the sender quoted it. */
  replyTo: QuotedMessage | null;
  /** Set on every readable message of kind "reaction". */
  reaction: MessageContent['reaction'] | null;
  /** A shared pull request, shown as a card instead of the text. */
  pull: PullCardDTO | null;
  /** Set on every readable message of kind "github": the card the server wrote from GitHub. */
  github: GithubCardDTO | null;
  /** A card handed to a coding agent, or the agent's report on it (R-027). */
  run: RunDTO | null;
  /** A message of a conversation with the owner's coding agent (D-102). */
  prompt: PromptDTO | null;
  /** The owner's note that a card draft went on the board (D-104). */
  added: MessageContent['added'] | null;
  /**
   * "plain" for messages from before encryption; "github" for a card the server wrote, which
   * nobody signs; "failed" if decryption or the signature check failed.
   */
  security: 'encrypted' | 'plain' | 'github' | 'failed';
}

/** A message as the page shows it: the server's copy plus its readable content. */
export interface ChatMessage extends MessageDTO, Opened {}

export interface ChatConversation extends Omit<ConversationDTO, 'lastMessage'> {
  lastMessage: ChatMessage | null;
}

/** A doc as the page lists it, with its title decrypted. */
export interface ChatDoc extends DocDTO {
  name: string;
  /** Set on the two docs behind the project board (R-021), which the Docs list leaves out. */
  board?: DocContent['board'];
}

export { EncryptionUnavailableError, type KeyLookup };

const chatKeyStore: ChatKeyStore = {
  get: (conversationId, keyId) => keystore.getChatKey(conversationId, keyId).catch(() => undefined),
  set: (conversationId, keyId, key) => keystore.setChatKey(conversationId, keyId, key).catch(() => undefined),
};
/** The unlocked account's keyring, with its chat keys and whose keys changed. Null when locked. */
let keys: Keyring | null = null;
/** Content already decrypted, by message id, with the signed fields it was checked against. */
const opened = new Map<number, { content: Opened; signed: string }>();
/**
 * Messages and reactions that failed to open, by id. The store drops a failed reaction, so these
 * stay here for reopen to try again after the user checks a changed security code (D-018).
 */
const held = new Map<number, MessageDTO>();
/** Doc revisions already decrypted, by revision id, with what their signature covered. */
const openedDocs = new Map<number, { content: DocContent; signed: string }>();

type SignedMeta = Pick<MessageDTO, 'conversationId' | 'senderId' | 'urgent' | 'kind' | 'clientId'>;

/**
 * What a message's signature covers, plus the signature itself. The server can send a message
 * again with other values in these fields; then the cached content must not be shown under them.
 */
const signedFields = (meta: SignedMeta, envelope: EnvelopeDTO) =>
  JSON.stringify([meta.conversationId, meta.senderId, meta.urgent, meta.kind, meta.clientId ?? '', envelope.kid, envelope.sig]);

const openedFrom = (content: MessageContent): Opened => ({
  text: content.text,
  replyTo: content.replyTo ?? null,
  reaction: content.reaction ?? null,
  pull: content.pull ?? null,
  github: null,
  run: content.run ?? null,
  prompt: content.prompt ?? null,
  added: content.added ?? null,
  security: 'encrypted',
});

/** People a chat key gets wrapped for must have keys, and keys this device has not seen change. */
function checkRecipients(members: Array<{ id: number; name: string; keys: PublicKeysDTO | null }>, changed: Set<number>) {
  const missing = members.filter((m) => !m.keys).map((m) => m.name);
  if (missing.length) {
    throw new EncryptionUnavailableError(`${missing.join(', ')} must sign in again to turn on encryption.`);
  }
  const suspicious = members.filter((m) => changed.has(m.id)).map((m) => m.name);
  if (suspicious.length) {
    throw new EncryptionUnavailableError(`Check ${suspicious.join(', ')}'s security code first.`);
  }
}
let pins: Record<number, string> | null = null;

export const keyring = {
  myKeys: (): PublicKeysDTO => keys!.self.identity.publicKeys,

  /** Loads this device's keys for the user. False means the user must unlock with their password. */
  async load(userId: number): Promise<boolean> {
    const stored = await keystore.getIdentity().catch(() => undefined);
    if (!stored || stored.userId !== userId) return false;
    // A reload of the same account keeps whose keys changed until checkKeys runs again.
    if (keys?.self.id !== userId) keys = new Keyring({ id: userId, identity: stored.identity }, chatKeyStore);
    return true;
  },

  /** Keeps freshly opened or created account keys on this device. */
  async adopt(userId: number, secrets: IdentitySecrets) {
    const identity = await importIdentity(secrets);
    await keystore.clearKeys();
    await keystore.setIdentity({ userId, identity });
    keys = new Keyring({ id: userId, identity }, chatKeyStore);
    pins = null;
  },

  createSecrets: () => createIdentity(),

  /** Drops every key from memory and from this device. The pins of other people's keys stay. */
  async forget() {
    keys = null;
    pins = null;
    opened.clear();
    held.clear();
    openedDocs.clear();
    await keystore.clearKeys().catch(() => undefined);
  },

  /**
   * Shares everyone's public keys with the service worker, and compares each person's keys with
   * the ones first seen on this device. Returns the people whose keys changed since. Their keys stay
   * out of the service worker's directory, so a push signed with them shows no text.
   */
  async checkKeys(users: UserDTO[]): Promise<Set<number>> {
    const ring = keys!;
    pins ??= (await keystore.getPins().catch(() => undefined)) ?? {};
    const pinned = await ring.checkPins(users, pins);
    const directory: Record<number, PublicKeysDTO> = { [ring.self.id]: ring.self.identity.publicKeys };
    for (const user of users) if (user.keys && !ring.changed.has(user.id)) directory[user.id] = user.keys;
    await Promise.all([keystore.setDirectory(directory), pinned ? keystore.setPins(pins) : undefined]).catch(() => undefined);
    return ring.changed;
  },

  /** Accepts a person's new keys after the user checked the security code with them. */
  async trust(user: UserDTO) {
    if (!user.keys) return;
    pins ??= (await keystore.getPins().catch(() => undefined)) ?? {};
    pins[user.id] = await keyFingerprint(user.keys);
    await keystore.setPins(pins);
  },

  /** Opens this user's copy of a chat key, after checking that a member of the chat created it. */
  chatKey: (conversation: KeyedConversation, keysOf: KeyLookup) => keys?.chatKey(conversation, keysOf) ?? null,

  /** Opens the key a message names: the chat's current key, or an earlier one through its links. */
  keyFor: (conversation: KeyedConversation, keyId: string, keysOf: KeyLookup) => keys?.keyFor(conversation, keyId, keysOf) ?? null,

  /** Makes a new chat key and wraps it for every member. Refuses members without keys or with changed keys. */
  async createChatKey(members: Array<{ id: number; name: string; keys: PublicKeysDTO | null }>, changed: Set<number>) {
    checkRecipients(members, changed);
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const wrappedKeys = await Promise.all(
      members.map(async (m) => ({ userId: m.id, ...(await wrapChatKey(raw, keys!.self, { id: m.id, dh: m.keys!.dh }, keyId)) })),
    );
    const input: ChatKeyInput = { keyId, wrappedKeys };
    return { input, key: await importChatKey(raw) };
  },

  /**
   * Wraps a chat's existing key for people joining it, from this user's own copy, so they can read
   * its history too. Checks first that a member of the chat made that copy.
   */
  async shareChatKey(
    conversation: Pick<ConversationDTO, 'keyId' | 'myKey' | 'members'>,
    keysOf: KeyLookup,
    recipients: Array<{ id: number; name: string; keys: PublicKeysDTO | null }>,
    changed: Set<number>,
  ): Promise<WrappedKeyInput[]> {
    checkRecipients(recipients, changed);
    const { keyId, myKey } = conversation;
    const wrapperKeys = myKey ? keysOf(myKey.wrappedBy) : null;
    if (!keyId || !myKey || !wrapperKeys || !conversation.members.some((m) => m.userId === myKey.wrappedBy)) {
      throw new EncryptionUnavailableError('This device cannot open one of the channel keys. Reload the page.');
    }
    if (keys!.unchecked(myKey.wrappedBy)) {
      throw new EncryptionUnavailableError(WRAPPER_CHANGED);
    }
    const raw = await openChatKeyBytes(myKey, keys!.self, { id: myKey.wrappedBy, dh: wrapperKeys.dh }, keyId);
    return Promise.all(recipients.map(async (r) => ({ userId: r.id, ...(await wrapChatKey(raw, keys!.self, { id: r.id, dh: r.keys!.dh }, keyId)) })));
  },

  /**
   * Makes a new key to replace a chat's current one, wrapped for the given members, with the current
   * key inside it so they can still read the messages from before.
   */
  async rotateChatKey(
    conversation: Pick<ConversationDTO, 'id' | 'keyId' | 'myKey'>,
    keysOf: KeyLookup,
    members: Array<{ id: number; name: string; keys: PublicKeysDTO | null }>,
    changed: Set<number>,
  ): Promise<{ input: RotatedKeyInput; key: CryptoKey }> {
    const { id, keyId, myKey } = conversation;
    const wrapperKeys = myKey ? keysOf(myKey.wrappedBy) : null;
    if (!keyId || !myKey || !wrapperKeys) throw new EncryptionUnavailableError('This device cannot open the chat key. Reload the page.');
    // Unlike chatKey, the wrapper need not be a member still: after someone leaves, they may have
    // wrapped this copy. The old key only goes inside the new one, to read old messages, and never
    // encrypts anything again.
    const previous = await openChatKeyBytes(myKey, keys!.self, { id: myKey.wrappedBy, dh: wrapperKeys.dh }, keyId);
    const { input, key } = await keyring.createChatKey(members, changed);
    const link = await linkChatKey(key, input.keyId, id, previous, keyId);
    return { input: { ...input, link: { previousKeyId: keyId, ...link } }, key };
  },

  /** Keeps a chat key this device created, once the server has assigned the chat its id. */
  remember: (conversationId: number, keyId: string, key: CryptoKey) => keys!.remember(conversationId, keyId, key),

  async seal(
    chatKey: CryptoKey,
    keyId: string,
    meta: { conversationId: number; urgent: boolean; clientId: string; kind: MessageKind },
    content: MessageContent,
  ) {
    return encryptMessage(chatKey, keyId, keys!.self.identity.signPrivate, { ...meta, senderId: keys!.self.id }, content);
  },

  sealDoc(chatKey: CryptoKey, keyId: string, meta: Omit<DocMeta, 'authorId'>, content: DocContent) {
    return encryptDoc(chatKey, keyId, keys!.self.identity.signPrivate, { ...meta, authorId: keys!.self.id }, content);
  },

  /** Decrypts a doc revision and checks its author's signature. Null when either fails. */
  async openDoc(revision: DocRevisionDTO, conversation: ChatConversation, keysOf: KeyLookup): Promise<DocContent | null> {
    const meta: DocMeta = { conversationId: conversation.id, authorId: revision.authorId, docId: revision.docId, section: revision.section };
    // A save replaces its revision in place, so the signature tells an old copy from a new one.
    const signed = JSON.stringify([meta, revision.envelope.kid, revision.envelope.sig]);
    const known = openedDocs.get(revision.id);
    if (known?.signed === signed) return known.content;
    try {
      const { key, signKey } = await signedWith(conversation, revision.envelope.kid, revision.authorId, keysOf);
      const content = await decryptDoc(key, signKey, meta, revision.envelope);
      openedDocs.set(revision.id, { content, signed });
      return content;
    } catch {
      return null;
    }
  },

  /** Remembers what a message this device just sent says, so it never needs decrypting. */
  rememberContent(messageId: number, meta: SignedMeta, envelope: EnvelopeDTO, content: MessageContent) {
    opened.set(messageId, { content: openedFrom(content), signed: signedFields(meta, envelope) });
  },

  /** Decrypts a message and checks its signature. Never throws: failures come back as "failed". */
  async open(message: MessageDTO, conversation: ChatConversation | ConversationDTO, keysOf: KeyLookup): Promise<ChatMessage> {
    const none = { replyTo: null, reaction: null, pull: null, github: null, run: null, prompt: null, added: null };
    if (message.kind === 'github') {
      // Shown as GitHub's, never as a person's, whatever sender the server names.
      const card = readGithubCard(message.body);
      return card
        ? { ...message, ...none, senderId: null, text: describeGithubCard(card), pull: card.pull, github: card, security: 'github' }
        : { ...message, ...none, senderId: null, text: '', security: 'failed' };
    }
    if (!message.envelope) return { ...message, ...none, text: message.body, security: 'plain' };
    const signed = signedFields(message, message.envelope);
    const known = opened.get(message.id);
    if (known?.signed === signed) return { ...message, ...known.content };
    try {
      const result = openedFrom(await decrypt(message, message.envelope, conversation, keysOf));
      if ((message.kind === 'reaction') !== (result.reaction !== null)) throw new Error('Reaction without its emoji.');
      if (message.id > 0) opened.set(message.id, { content: result, signed });
      held.delete(message.id);
      return { ...message, ...result };
    } catch {
      if (message.id > 0) held.set(message.id, message);
      return { ...message, ...none, text: '', security: 'failed' };
    }
  },

  /** Opens again every message that failed in a chat still listed, and returns those that open now. */
  async reopen(conversations: Record<number, ChatConversation>, keysOf: KeyLookup): Promise<ChatMessage[]> {
    const listed = [...held.values()].filter((m) => conversations[m.conversationId]);
    const tried = await Promise.all(listed.map((m) => keyring.open(m, conversations[m.conversationId]!, keysOf)));
    return tried.filter((m) => m.security !== 'failed');
  },
};

/**
 * The chat key something was sealed with, and its signer's public signing key. Throws when either
 * is missing, or when the signer's keys changed and the user has not checked them (D-018).
 */
async function signedWith(conversation: ChatConversation | ConversationDTO, keyId: string, signerId: number, keysOf: KeyLookup) {
  const key = await keyring.keyFor(conversation, keyId, keysOf);
  const signerKeys = keys?.unchecked(signerId) ? null : keysOf(signerId);
  if (!key || !signerKeys) throw new Error('Missing keys.');
  return { key, signKey: signerKeys.sign };
}

async function decrypt(message: MessageDTO, envelope: EnvelopeDTO, conversation: ChatConversation | ConversationDTO, keysOf: KeyLookup) {
  const { conversationId, senderId, urgent, clientId, kind } = message;
  if (senderId === null) throw new Error('Missing keys.');
  const { key, signKey } = await signedWith(conversation, envelope.kid, senderId, keysOf);
  return decryptContent(key, signKey, { conversationId, senderId, urgent, clientId: clientId ?? '', kind }, envelope);
}
