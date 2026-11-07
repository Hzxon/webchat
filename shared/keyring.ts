// The trust decisions about chat keys, shared by the page (client/src/e2ee/keyring.ts) and the
// coding agent's client (agent/client.ts), so a fix lands in both (K-40). It holds no storage: the
// page passes IndexedDB and the agent its account file.
import { keyFingerprint, openChatKeyBytes, openKeyLink, unwrapChatKey, type Identity } from './e2ee.js';
import type { ConversationDTO, PublicKeysDTO, UserDTO } from './types.js';

/** Looks up a person's public keys: the server's list for others, the unlocked keys for oneself. */
export type KeyLookup = (userId: number) => PublicKeysDTO | null;

/** Chat keys kept across restarts, by chat and key id. Failures read as a missing key. */
export interface ChatKeyStore {
  get(conversationId: number, keyId: string): Promise<CryptoKey | undefined>;
  set(conversationId: number, keyId: string, key: CryptoKey): Promise<unknown>;
}

export type KeyedConversation = Pick<ConversationDTO, 'id' | 'keyId' | 'myKey' | 'members' | 'keyLinks'>;

export class EncryptionUnavailableError extends Error {}

/** This account's copy of the chat's key names no chat, so the key opens old messages but never seals (K-65). */
export class OldKeyCopyError extends EncryptionUnavailableError {
  constructor() {
    super("This chat's key is from before keys named their chat. Sending from the web page gives it a new one.");
  }
}

export const WRAPPER_CHANGED = "The security code of whoever shared this chat's key changed. Check it first.";

export class Keyring {
  /** People whose keys differ from the pinned ones, as of the last checkPins. */
  changed = new Set<number>();
  private readonly cache = new Map<string, Promise<CryptoKey>>();

  /**
   * @param replaced By chat id, the key ids a key link showed replaced. The server could drop a
   * link and name the old key current again, so the device keeps what it saw (K-43).
   * @param saveReplaced Keeps `replaced` on the device when it grows.
   */
  constructor(
    readonly self: { id: number; identity: Identity },
    private replaced: Record<number, string[]>,
    private readonly saveReplaced: (replaced: Record<number, string[]>) => void,
    private readonly store?: ChatKeyStore,
  ) {}

  /**
   * Pins each person's keys the first time they are seen, into `pins`, and notes whose keys changed
   * since (D-018). True when a new pin needs saving.
   */
  async checkPins(users: UserDTO[], pins: Record<number, string>) {
    const changed = new Set<number>();
    let pinned = false;
    const fingerprints = await Promise.all(users.map((u) => (u.keys ? keyFingerprint(u.keys) : null)));
    users.forEach((user, i) => {
      const fingerprint = fingerprints[i];
      if (!fingerprint) return;
      if (!pins[user.id]) {
        pins[user.id] = fingerprint;
        pinned = true;
      } else if (pins[user.id] !== fingerprint) {
        changed.add(user.id);
      }
    });
    this.changed = changed;
    return pinned;
  }

  /**
   * Keys not checked since they changed. A key the server swapped would let it open chat keys it
   * wrapped and sign in that person's name, so nothing trusts them (D-018). One's own keys come
   * from this device, never from the server.
   */
  unchecked(userId: number) {
    return userId !== this.self.id && this.changed.has(userId);
  }

  /** Opens this account's copy of a chat key, after checking that a member of the chat created it. */
  chatKey(conversation: KeyedConversation, keysOf: KeyLookup): Promise<CryptoKey> | null {
    const { id, keyId, myKey } = conversation;
    if (!keyId || !myKey) return null;
    // A key that a newer one replaced never encrypts again, even if the server names it current.
    const seen = this.replaced[id] ?? [];
    const fresh = conversation.keyLinks.map((link) => link.previousKeyId).filter((k) => !seen.includes(k));
    if (fresh.length) {
      this.replaced = { ...this.replaced, [id]: [...seen, ...fresh] };
      this.saveReplaced(this.replaced);
    }
    if (this.replaced[id]?.includes(keyId)) return null;
    return this.cached(id, keyId, async () => {
      const wrapperKeys = keysOf(myKey.wrappedBy);
      if (!wrapperKeys || !conversation.members.some((m) => m.userId === myKey.wrappedBy)) {
        throw new Error('The chat key was not created by a member of this chat.');
      }
      // A key stored before the change still opens messages; a new one waits for the check.
      if (this.unchecked(myKey.wrappedBy)) throw new EncryptionUnavailableError(WRAPPER_CHANGED);
      return unwrapChatKey(myKey, this.self, { id: myKey.wrappedBy, dh: wrapperKeys.dh }, keyId, id);
    });
  }

  /**
   * The chat's current key, to seal with. Refuses it when this account's copy is from before
   * D-111: such a copy names no chat, so the server could have taken it from another chat between
   * the same two people, where someone removed from this one still holds it (K-65). Checked on
   * every seal, since a key from the store says nothing about its copy, so a stored key whose
   * wrapper's keys changed seals only once the copy opens with their checked keys (D-018).
   */
  async sealingKey(conversation: KeyedConversation, keysOf: KeyLookup): Promise<CryptoKey | null> {
    const key = await this.chatKey(conversation, keysOf);
    if (!key) return null;
    const { id, keyId, myKey } = conversation;
    if (this.unchecked(myKey!.wrappedBy)) throw new EncryptionUnavailableError(WRAPPER_CHANGED);
    const wrapperKeys = keysOf(myKey!.wrappedBy);
    if (!wrapperKeys || !(await openChatKeyBytes(myKey!, this.self, { id: myKey!.wrappedBy, dh: wrapperKeys.dh }, keyId!, id)).namesChat) {
      throw new OldKeyCopyError();
    }
    return key;
  }

  /**
   * Opens the key a message names: the chat's current key, or an earlier one, which the key that
   * replaced it holds inside (see ConversationDTO.keyLinks).
   */
  keyFor(conversation: KeyedConversation, keyId: string, keysOf: KeyLookup): Promise<CryptoKey> | null {
    if (keyId === conversation.keyId) return this.chatKey(conversation, keysOf);
    // The links from this key up to the current one, newest first. A real chain uses each link at
    // most once, so a longer one is a loop the server made. Walked before anything is cached: an
    // open that waited on another key's pending open would wait forever on a loop.
    const chain: KeyedConversation['keyLinks'] = [];
    for (let id = keyId; id !== conversation.keyId; ) {
      const link = conversation.keyLinks.find((l) => l.previousKeyId === id);
      if (!link || chain.length === conversation.keyLinks.length) return null;
      chain.unshift(link);
      id = link.keyId;
    }
    return this.cached(conversation.id, keyId, async () => {
      let key = await this.chatKey(conversation, keysOf);
      if (!key) throw new Error('The chat key that replaced this one is not available.');
      for (const link of chain) key = await openKeyLink(key, link.keyId, conversation.id, link, link.previousKeyId);
      return key;
    });
  }

  /** Keeps a chat key this account created, once the server has assigned the chat its id. */
  async remember(conversationId: number, keyId: string, key: CryptoKey) {
    this.cache.set(`${conversationId}:${keyId}`, Promise.resolve(key));
    await this.store?.set(conversationId, keyId, key);
  }

  /** One open per key at a time: the stored key if there is one, else `open`'s, which gets stored. */
  private cached(conversationId: number, keyId: string, open: () => Promise<CryptoKey>) {
    const name = `${conversationId}:${keyId}`;
    let pending = this.cache.get(name);
    if (!pending) {
      pending = (async () => {
        const stored = await this.store?.get(conversationId, keyId);
        if (stored) return stored;
        const key = await open();
        await this.store?.set(conversationId, keyId, key);
        return key;
      })();
      this.cache.set(name, pending);
      pending.catch(() => this.cache.delete(name));
    }
    return pending;
  }
}
