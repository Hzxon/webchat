// A headless WebChat account for the agent daemon (R-027, D-085). It does what a browser tab does
// with no page: signs up or in, keeps its keys in a file, checks in with POST /api/sync, opens chat
// keys and messages, sends sealed messages, and edits doc sections under the section lock. The
// logic follows client/src/e2ee/keyring.ts and client/src/chat.ts; what is browser-only there
// (IndexedDB, push, alerts, the store) has no counterpart here.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createIdentity,
  decryptContent,
  decryptDoc,
  deriveAccountSecrets,
  encryptDoc,
  encryptMessage,
  importIdentity,
  keyFingerprint,
  openIdentity,
  openKeyLink,
  sealIdentity,
  unwrapChatKey,
  type DocContent,
  type DocMeta,
  type Identity,
  type IdentitySecrets,
  type MessageContent,
} from '../shared/e2ee.ts';
import type {
  BootstrapDTO,
  ConfigDTO,
  ConversationDTO,
  DocDTO,
  DocRevisionDTO,
  LoginResponse,
  MessageDTO,
  MessageKind,
  ProjectDTO,
  PublicKeysDTO,
  SyncRequest,
  SyncResponse,
  UserDTO,
} from '../shared/types.ts';
import { Api, ApiError } from './api.ts';

/** What the daemon keeps on disk for one account. Only its owner can read the file. */
export interface AccountFile {
  server: string;
  username: string;
  userId: number;
  /** The login key, so the daemon signs in again without the password when its session ends. */
  authKey: string;
  /** The private keys in the clear: Node has no key store that keeps them unexportable. */
  secrets: IdentitySecrets;
  cookie: string;
  /** Fingerprints of other people's keys, first seen (D-018). */
  pins: Record<number, string>;
  /** The newest message id seen, so a restart picks up what arrived while the daemon was down. */
  cursor: number;
  /**
   * The person whose run requests this account carries out, by user id, as the server named them at
   * sign-up or sign-in (D-089). Their keys are pinned like anyone's. Null for an account that runs
   * no cards.
   */
  owner: number | null;
}

export interface Credentials {
  server: string;
  username: string;
  password: string;
  /** Fewer PBKDF2 rounds keep tests fast. An account signs in only with the rounds it signed up with. */
  kdfIterations?: number;
}

/** A message with its content opened, or "failed" when it could not be decrypted or verified. */
export interface OpenedMessage extends MessageDTO {
  content: MessageContent | null;
  security: 'encrypted' | 'plain' | 'github' | 'failed';
}

export interface DocSection {
  id: string;
  text: string;
  pos: number;
  /** Who saved this text last. */
  authorId: number;
}

/** How often the daemon checks in. It has no push, so this is its whole delay (D-004). */
export const SYNC_INTERVAL_MS = 15_000;

export class AgentClient {
  readonly api: Api;
  readonly id: number;
  readonly identity: Identity;
  users = new Map<number, UserDTO>();
  projects: ProjectDTO[] = [];
  conversations = new Map<number, ConversationDTO>();
  docs: DocDTO[] = [];
  private stamp = '';
  private readonly tabId = crypto.randomUUID();
  private readonly chatKeys = new Map<string, Promise<CryptoKey>>();
  /**
   * Messages already returned, by id, with when they were sent: a check-in answer repeats the last
   * 15 seconds of the one before (D-021), so an id stays here until it is older than that.
   */
  private readonly seen = new Map<number, number>();
  /** Where this run started. Anything up to here was returned by an earlier run, or is history. */
  private readonly floor: number;
  /** People whose keys differ from the pinned ones. Nothing from them opens until someone checks. */
  private readonly changedKeys = new Set<number>();
  /** Said in every check-in while a card runs, so the board offers this account no other (R-027). */
  busy = false;

  private constructor(
    private readonly file: AccountFile,
    private readonly filePath: string,
    identity: Identity,
  ) {
    this.api = new Api(file.server, file.cookie);
    this.id = file.userId;
    this.identity = identity;
    this.floor = file.cursor;
  }

  /** The person whose cards this account runs (D-089). Files from before it have none. */
  get owner() {
    return this.file.owner ?? null;
  }

  /**
   * Makes a new account and writes its file. The file must not exist yet. With an owner's username,
   * the account is that person's coding agent.
   */
  static async signUp(filePath: string, credentials: Credentials, displayName: string, inviteCode: string, owner?: string) {
    const api = new Api(credentials.server);
    const { authKey, backupKey } = await secretsFor(api, credentials);
    const secrets = await createIdentity();
    const user = await api.request<UserDTO>('POST', '/auth/register', {
      username: credentials.username,
      displayName,
      authKey,
      inviteCode,
      keys: { ...secrets.publicKeys, backup: await sealIdentity(secrets, backupKey) },
      owner,
    });
    const file = { server: credentials.server, username: credentials.username, userId: user.id, authKey, secrets, cookie: api.cookie, owner: user.agentOwner };
    return AgentClient.create(filePath, file, 'wx');
  }

  /**
   * Signs in to an existing account, opens its key backup with the password, and writes the file.
   * With an owner's username, the account becomes that person's coding agent.
   */
  static async signIn(filePath: string, credentials: Credentials, owner?: string) {
    const api = new Api(credentials.server);
    const { authKey, backupKey } = await secretsFor(api, credentials);
    const { user, backup } = await api.request<LoginResponse>('POST', '/auth/login', { username: credentials.username, authKey, owner });
    if (!backup) throw new Error('This account has no keys yet. Sign in once in a browser first.');
    const secrets = await openIdentity(backup, backupKey);
    if (user.keys?.dh !== secrets.publicKeys.dh || user.keys.sign !== secrets.publicKeys.sign) {
      throw new Error('The keys the server lists for this account are not the ones in its backup.');
    }
    return AgentClient.create(filePath, { server: credentials.server, username: credentials.username, userId: user.id, authKey, secrets, cookie: api.cookie, owner: user.agentOwner });
  }

  /** Opens the account an earlier sign-up or sign-in wrote. */
  static async load(filePath: string) {
    const file = JSON.parse(await fs.readFile(filePath, 'utf8')) as AccountFile;
    return new AgentClient(file, filePath, await importIdentity(file.secrets));
  }

  /**
   * Writes the account file: a sign-up must not overwrite one, a sign-in replaces it. Messages from
   * before this moment are history, not news to act on.
   */
  private static async create(filePath: string, data: Omit<AccountFile, 'pins' | 'cursor'>, flag?: string) {
    const api = new Api(data.server, data.cookie);
    const { cursor } = await api.request<BootstrapDTO>('GET', '/bootstrap');
    const file: AccountFile = { ...data, pins: {}, cursor };
    const client = new AgentClient(file, filePath, await importIdentity(file.secrets));
    await client.save(flag);
    return client;
  }

  private async save(flag?: string) {
    this.file.cookie = this.api.cookie;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(this.file, null, 2) + '\n', { flag, mode: 0o600 });
  }

  /** A request that signs in again once when the session has ended, then keeps the new cookie. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.api.request<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      await this.api.request('POST', '/auth/login', { username: this.file.username, authKey: this.file.authKey });
      await this.save();
      return this.api.request<T>(method, path, body);
    }
  }

  /**
   * Checks in once, as a tab the user looks at, so the account shows as online. Catches up when
   * the answer says more is waiting. Returns the messages of other people that are new to this
   * client, opened, oldest first.
   */
  async sync(): Promise<OpenedMessage[]> {
    // The first check-in of a run sends no stamp, so it answers in full, from the saved cursor.
    const fresh: MessageDTO[] = [];
    let dirty = false;
    for (let rounds = 0; rounds < 10; rounds++) {
      const body: SyncRequest = { cursor: this.file.cursor, stamp: this.stamp, attentive: true, tabId: this.tabId, endpoint: null, busy: this.busy };
      const answer = await this.request<SyncResponse>('POST', '/sync', body);
      dirty ||= answer.cursor !== this.file.cursor;
      this.file.cursor = answer.cursor;
      this.stamp = answer.stamp;
      if (!answer.changed) break;
      this.users = new Map(answer.users.map((u) => [u.id, u]));
      this.projects = answer.projects;
      this.conversations = new Map(answer.conversations.map((c) => [c.id, c]));
      this.docs = answer.docs;
      dirty = (await this.checkKeys(answer.users)) || dirty;
      fresh.push(...answer.messages);
      if (!answer.more) break;
    }
    if (dirty) await this.save();
    const mine = fresh
      .filter((m) => m.id > this.floor && m.senderId !== this.id && !this.seen.has(m.id) && this.conversations.has(m.conversationId))
      .sort((a, b) => a.id - b.id);
    const newest = Math.max(0, ...fresh.map((m) => m.createdAt));
    for (const [id, sentAt] of this.seen) if (sentAt < newest - 60_000) this.seen.delete(id);
    for (const m of mine) this.seen.set(m.id, m.createdAt);
    return Promise.all(mine.map((m) => this.open(m)));
  }

  /** Checks in every SYNC_INTERVAL_MS, for as long as the signal allows, and yields each new message. */
  async *watch(signal: AbortSignal, intervalMs = SYNC_INTERVAL_MS): AsyncGenerator<OpenedMessage> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        yield* await this.sync();
        failures = 0;
      } catch (error) {
        // A rate limit passes, like an outage; other refusals do not.
        if (error instanceof ApiError && error.status !== 0 && error.status !== 429 && error.status < 500) throw error;
        failures++;
      }
      const delay = failures ? Math.min(60_000, intervalMs * 2 ** failures) : intervalMs;
      await sleep(delay, undefined, { signal }).catch(() => undefined);
    }
  }

  /**
   * Pins each person's keys the first time they are seen, and notes whose keys changed since
   * (D-018). True when a new pin needs saving.
   */
  private async checkKeys(users: UserDTO[]) {
    let pinned = false;
    this.changedKeys.clear();
    const fingerprints = await Promise.all(users.map((u) => (u.keys ? keyFingerprint(u.keys) : null)));
    users.forEach((user, i) => {
      const fingerprint = fingerprints[i];
      if (!fingerprint) return;
      if (!this.file.pins[user.id]) {
        this.file.pins[user.id] = fingerprint;
        pinned = true;
      } else if (this.file.pins[user.id] !== fingerprint) {
        this.changedKeys.add(user.id);
      }
    });
    return pinned;
  }

  /** A person's public keys: one's own from the file, others from the server, unless they changed. */
  keysOf(userId: number): PublicKeysDTO | null {
    if (userId === this.id) return this.identity.publicKeys;
    return this.changedKeys.has(userId) ? null : (this.users.get(userId)?.keys ?? null);
  }

  /** The chat's current key, for sealing. */
  private async currentKey(conversationId: number) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.keyId) throw new Error('Not a member of this chat, or it has no key.');
    return { keyId: conversation.keyId, key: await this.chatKey(conversation) };
  }

  /** Opens this account's copy of the chat's current key, after checking that a member wrapped it. */
  private chatKey(conversation: ConversationDTO): Promise<CryptoKey> {
    const { id, keyId, myKey } = conversation;
    if (!keyId || !myKey) return Promise.reject(new Error('The chat has no key.'));
    if (conversation.keyLinks.some((link) => link.previousKeyId === keyId)) return Promise.reject(new Error('The key was replaced.'));
    return this.cached(id, keyId, async () => {
      const wrapperKeys = this.keysOf(myKey.wrappedBy);
      if (!wrapperKeys || !conversation.members.some((m) => m.userId === myKey.wrappedBy)) {
        throw new Error('The chat key was not created by a member of this chat, or their keys changed.');
      }
      return unwrapChatKey(myKey, { id: this.id, identity: this.identity }, { id: myKey.wrappedBy, dh: wrapperKeys.dh }, keyId);
    });
  }

  /** The key a message names: the current one, or an earlier one found through the key links. */
  private keyFor(conversation: ConversationDTO, keyId: string, steps = 0): Promise<CryptoKey> {
    if (keyId === conversation.keyId) return this.chatKey(conversation);
    const link = conversation.keyLinks.find((l) => l.previousKeyId === keyId);
    // Each step goes from a key to the one before it, so a chain the server looped stops here.
    if (!link || steps > conversation.keyLinks.length) return Promise.reject(new Error('No key for this message.'));
    return this.cached(conversation.id, keyId, async () =>
      openKeyLink(await this.keyFor(conversation, link.keyId, steps + 1), link.keyId, conversation.id, link, keyId),
    );
  }

  private cached(conversationId: number, keyId: string, open: () => Promise<CryptoKey>) {
    const name = `${conversationId}:${keyId}`;
    let pending = this.chatKeys.get(name);
    if (!pending) {
      pending = open();
      this.chatKeys.set(name, pending);
      pending.catch(() => this.chatKeys.delete(name));
    }
    return pending;
  }

  /** Decrypts a message and checks its sender's signature. Never throws: failures come back as "failed". */
  async open(message: MessageDTO): Promise<OpenedMessage> {
    if (message.kind === 'github') return { ...message, content: null, security: 'github' };
    if (!message.envelope) return { ...message, content: { text: message.body }, security: 'plain' };
    const conversation = this.conversations.get(message.conversationId);
    const signerKeys = message.senderId === null ? null : this.keysOf(message.senderId);
    if (!conversation || !signerKeys) return { ...message, content: null, security: 'failed' };
    try {
      const key = await this.keyFor(conversation, message.envelope.kid);
      const { conversationId, senderId, urgent, clientId, kind } = message;
      const meta = { conversationId, senderId: senderId!, urgent, clientId: clientId ?? '', kind };
      return { ...message, content: await decryptContent(key, signerKeys.sign, meta, message.envelope), security: 'encrypted' };
    } catch {
      return { ...message, content: null, security: 'failed' };
    }
  }

  /** Sends a sealed message. Throws an ApiError with code stale_key or needs_new_key when the chat's key moved on. */
  async send(conversationId: number, content: MessageContent, options: { urgent?: boolean; kind?: Exclude<MessageKind, 'github'> } = {}) {
    const { keyId, key } = await this.currentKey(conversationId);
    const { urgent = false, kind = 'message' } = options;
    const clientId = crypto.randomUUID();
    const meta = { conversationId, senderId: this.id, urgent, clientId, kind };
    const envelope = await encryptMessage(key, keyId, this.identity.signPrivate, meta, content);
    return this.request<MessageDTO>('POST', `/conversations/${conversationId}/messages`, { envelope, urgent, clientId, kind });
  }

  /** Decrypts a doc revision and checks its author's signature. Null when either fails. */
  async openDoc(doc: DocDTO, revision: DocRevisionDTO): Promise<DocContent | null> {
    const conversation = this.conversations.get(doc.conversationId);
    const authorKeys = this.keysOf(revision.authorId);
    if (!conversation || !authorKeys) return null;
    const meta: DocMeta = { conversationId: doc.conversationId, authorId: revision.authorId, docId: doc.id, section: revision.section };
    try {
      return await decryptDoc(await this.keyFor(conversation, revision.envelope.kid), authorKeys.sign, meta, revision.envelope);
    } catch {
      return null;
    }
  }

  /** The project's board docs, by column: the oldest of each, as the page picks them (D-082). */
  async boardDocs(projectId: number): Promise<Partial<Record<NonNullable<DocContent['board']>, DocDTO>>> {
    const found: Partial<Record<NonNullable<DocContent['board']>, DocDTO>> = {};
    const docs = this.docs.filter((d) => d.title && this.conversations.get(d.conversationId)?.projectId === projectId);
    const titles = await Promise.all(docs.map((d) => this.openDoc(d, d.title!)));
    docs.forEach((doc, i) => {
      const board = titles[i]?.board;
      if (!board) return;
      const have = found[board];
      // The same tie-break as boardDocs in client/src/board.ts.
      if (!have || doc.createdAt < have.createdAt || (doc.createdAt === have.createdAt && doc.id < have.id)) found[board] = doc;
    });
    return found;
  }

  /** The doc's sections that open, in order. The title and removed sections are left out. */
  async sections(doc: DocDTO): Promise<DocSection[]> {
    const revisions = (await this.request<DocRevisionDTO[]>('GET', `/docs/${doc.id}`)).filter((r) => r.section !== 'title');
    const contents = await Promise.all(revisions.map((r) => this.openDoc(doc, r)));
    const sections: DocSection[] = [];
    revisions.forEach((revision, i) => {
      const content = contents[i];
      if (content && !content.removed) sections.push({ id: revision.section, text: content.text, pos: content.pos ?? revision.createdAt, authorId: revision.authorId });
    });
    return sections.sort((a, b) => a.pos - b.pos);
  }

  /** A revision sealed for the doc's chat, as this account's own. */
  async sealDoc(doc: Pick<DocDTO, 'id' | 'conversationId'>, section: string, content: DocContent) {
    const { keyId, key } = await this.currentKey(doc.conversationId);
    const meta: DocMeta = { conversationId: doc.conversationId, authorId: this.id, docId: doc.id, section };
    return encryptDoc(key, keyId, this.identity.signPrivate, meta, content);
  }

  /**
   * Edits a section in one editing session: takes its lock, reads the section as it is now, saves
   * what `edit` makes of it, and lets the lock go (D-081). Reading under the lock keeps what others
   * saved before it.
   */
  async editSection(doc: DocDTO, section: string, edit: (current: DocSection | undefined) => DocContent) {
    await this.request('POST', `/docs/${doc.id}/sections/${section}/lock`);
    try {
      const current = (await this.sections(doc)).find((s) => s.id === section);
      await this.request('PUT', `/docs/${doc.id}/sections/${section}`, { envelope: await this.sealDoc(doc, section, edit(current)) });
    } finally {
      await this.request('DELETE', `/docs/${doc.id}/sections/${section}/lock`).catch(() => undefined);
    }
  }
}

async function secretsFor(api: Api, { username, password, kdfIterations }: Credentials) {
  const { kdfSalt } = await api.request<ConfigDTO>('GET', '/config');
  return deriveAccountSecrets(password, username, kdfSalt, kdfIterations);
}
