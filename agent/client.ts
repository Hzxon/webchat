// A headless WebChat account for a coding agent (R-027, D-085), run by the daemon or the Claude
// Code plugin (R-030). It does what a browser tab does with no page: pairs with its owner, keeps its
// keys in a file, checks in with POST /api/sync, opens chat keys and messages, sends sealed
// messages, and edits doc sections under the section lock. The key checks come from
// shared/keyring.ts, as the page's do; the rest follows client/src/chat.ts. What is browser-only
// there (IndexedDB, push, alerts, the store) has no counterpart here. Tests also sign people up
// with it.
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
  pairingId,
  pairingProof,
  randomBytes,
  sealIdentity,
  toBase64Url,
  type DocContent,
  type DocMeta,
  type Identity,
  type IdentitySecrets,
  type MessageContent,
} from '../shared/e2ee.ts';
import { Keyring } from '../shared/keyring.ts';
import {
  PAIRING_TTL_MS,
  type BootstrapDTO,
  type ConfigDTO,
  type ConversationDTO,
  type DocDTO,
  type DocRevisionDTO,
  type MessageDTO,
  type MessageKind,
  type PairingDTO,
  type PairingInput,
  type ProjectDTO,
  type PublicKeysDTO,
  type SyncRequest,
  type SyncResponse,
  type UserDTO,
} from '../shared/types.ts';
import { Api, ApiError } from './api.ts';
import { REQUEST_TTL_MS } from './runs.ts';

/** What the daemon keeps on disk for one account. Only its owner can read the file. */
export interface AccountFile {
  server: string;
  username: string;
  userId: number;
  /** The login key, so the daemon signs in again when its session ends. An agent's is random. */
  authKey: string;
  /** The private keys in the clear: Node has no key store that keeps them unexportable. */
  secrets: IdentitySecrets;
  cookie: string;
  /** Fingerprints of other people's keys, first seen or as the owner checked them (D-018, D-110). */
  pins: Record<number, string>;
  /** By chat id, the key ids a key link showed replaced, which never seal again though the server drops the link (K-43). */
  replaced?: Record<number, string[]>;
  /** When the owner's page signed the last check of each person's keys that was pinned, by user id (D-110). */
  trusted?: Record<number, number>;
  /** The newest message id seen, so a restart picks up what arrived while the daemon was down. */
  cursor: number;
  /**
   * The person whose run requests this account carries out, by user id (D-089). Pairing pins their
   * keys from the code (R-030). Null for an account that runs no cards.
   */
  owner: number | null;
  /** The pairing that made the account, by its id, so a new code pairs again (R-030). */
  pairing?: string;
  /** Client ids of the run requests seen, with their send times, while a copy could still run (K-47). */
  handled?: Record<string, number>;
  /**
   * The requests being run. The cursor is past them already, so a daemon that stopped mid-run
   * finds them only here when it starts again, and reports them failed (K-46).
   */
  running?: TakenRequest[];
}

/** A run request the daemon took, by its message. */
export interface TakenRequest {
  message: number;
  conversation: number;
  /** The card's id, such as K-12, for the report's text. */
  card: string;
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

/**
 * Splits a pasted pairing code. The page shows it after its own address, as `<address>#<code>`,
 * so nobody types the address (R-031). A bare code, from a page older than that, needs `server`.
 */
export function readPairing(pasted: string, server: string) {
  const at = pasted.lastIndexOf('#');
  if (at >= 0) return { server: pasted.slice(0, at).trim(), code: pasted.slice(at + 1) };
  if (!server) throw new Error('Paste the whole code that WebChat shows, with its address.');
  return { server, code: pasted };
}

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
  /** Chat keys and whose keys changed: what nothing from them opens until someone checks. */
  private readonly keys: Keyring;
  /**
   * Messages already returned, by id, with when they were sent: a check-in answer repeats the last
   * 15 seconds of the one before (D-021), so an id stays here until it is older than that.
   */
  private readonly seen = new Map<number, number>();
  /** Where this run started. Anything up to here was returned by an earlier run, or is history. */
  private readonly floor: number;
  /** Said in every check-in from the plugin: every repository its laptop has a folder for (R-036). */
  repos: string[] | null = null;
  /** Said in every check-in from the plugin: what its sessions can do (D-103). */
  protocol = 0;
  /** The file's last write, which the next one waits for. */
  private written: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: AccountFile,
    private readonly filePath: string,
    identity: Identity,
  ) {
    this.api = new Api(file.server, file.cookie);
    this.id = file.userId;
    this.identity = identity;
    this.keys = new Keyring({ id: file.userId, identity }, file.replaced ?? {}, (replaced) => {
      this.file.replaced = replaced;
      this.save().catch(() => undefined);
    });
    this.floor = file.cursor;
  }

  /** The person whose cards this account runs (D-089). Files from before it have none. */
  get owner() {
    return this.file.owner ?? null;
  }

  /** The pairing that made this account, by id. Accounts from before R-030 have none. */
  get pairing() {
    return this.file.pairing;
  }

  /** Makes a person's account, as a browser does, and writes its file. The file must not exist yet. */
  static async signUp(filePath: string, credentials: Credentials, displayName: string, inviteCode: string) {
    const api = new Api(credentials.server);
    const { authKey, backupKey } = await secretsFor(api, credentials);
    const secrets = await createIdentity();
    const user = await api.request<UserDTO>('POST', '/auth/register', {
      username: credentials.username,
      displayName,
      authKey,
      inviteCode,
      keys: { ...secrets.publicKeys, backup: await sealIdentity(secrets, backupKey) },
    });
    const file = { server: credentials.server, username: credentials.username, userId: user.id, authKey, secrets, cookie: api.cookie, owner: null, pins: {} };
    return AgentClient.create(filePath, file, 'wx');
  }

  /**
   * Makes an agent's account by pairing with its owner (R-030, D-093). Files this half, with keys
   * made here, then waits for the owner to approve on their page. The approval holds the owner's
   * keys, proved with the code, so they are pinned before the first check-in. The code never leaves
   * this machine. Overwrites the file, so a new code pairs again.
   */
  static async pair(filePath: string, server: string, code: string, pollMs = 2000) {
    const api = new Api(server);
    const secrets = await createIdentity();
    const keys = secrets.publicKeys;
    // Random: an agent has no password to derive it from.
    const authKey = toBase64Url(randomBytes(32));
    const id = await pairingId(code);
    const half: PairingInput = { id, keys, proof: await pairingProof(code, keys), authKey };
    await api.request('POST', '/pairings', half);
    const until = Date.now() + PAIRING_TTL_MS;
    let approved: PairingDTO['approved'] | undefined;
    while (!(approved = (await api.request<PairingDTO | undefined>('GET', `/pairings/${id}`))?.approved)) {
      if (Date.now() > until) throw new Error('Nobody approved the pairing within 10 minutes. Make a new code in WebChat.');
      await sleep(pollMs);
    }
    const { user, owner, proof } = approved;
    if (proof !== (await pairingProof(code, keys, owner))) {
      throw new Error('The approval does not match the pairing code, so the server may have swapped keys. Make a new code.');
    }
    if (user.keys?.dh !== keys.dh || user.keys.sign !== keys.sign) throw new Error('The server made the account with other keys.');
    await api.request('POST', '/auth/login', { username: user.username, authKey });
    const pins = { [owner.id]: await keyFingerprint(owner.keys) };
    return AgentClient.create(filePath, { server, username: user.username, userId: user.id, authKey, secrets, cookie: api.cookie, owner: owner.id, pins, pairing: id });
  }

  /**
   * A copy of the account for one repository's Claude Code session (D-094): the same keys and pins,
   * with its own session, cursor and runs, so sessions in several repositories never write one
   * file. Messages from before it are history.
   */
  async copyTo(filePath: string) {
    const { cursor } = await this.request<BootstrapDTO>('GET', '/bootstrap');
    const copy = new AgentClient({ ...this.file, cursor, running: undefined, handled: undefined }, filePath, this.identity);
    await copy.save();
    return copy;
  }

  /** Opens the account an earlier sign-up or sign-in wrote. */
  static async load(filePath: string) {
    const file = JSON.parse(await fs.readFile(filePath, 'utf8')) as AccountFile;
    // A file from before R-037 keeps one request, not a list.
    if (file.running && !Array.isArray(file.running)) file.running = [file.running];
    return new AgentClient(file, filePath, await importIdentity(file.secrets));
  }

  /**
   * Writes the account file: a sign-up must not overwrite one, a pairing replaces it. Messages from
   * before this moment are history, not news to act on.
   */
  private static async create(filePath: string, data: Omit<AccountFile, 'cursor'>, flag?: string) {
    const api = new Api(data.server, data.cookie);
    const { cursor } = await api.request<BootstrapDTO>('GET', '/bootstrap');
    const file: AccountFile = { ...data, cursor };
    const client = new AgentClient(file, filePath, await importIdentity(file.secrets));
    await client.save(flag);
    return client;
  }

  private save(flag?: string) {
    // One write at a time: a run saves while check-ins do, and two writes at once can leave the
    // tail of the longer one behind the shorter, which no longer parses.
    this.written = this.written
      .catch(() => undefined)
      .then(async () => {
        this.file.cookie = this.api.cookie;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(this.filePath, JSON.stringify(this.file, null, 2) + '\n', { flag, mode: 0o600 });
      });
    return this.written;
  }

  /** The requests a daemon took and did not report on to the end, as the file keeps them. */
  get running() {
    return this.file.running ?? [];
  }

  /** Keeps the requests being run in the file. */
  async saveRunning(running: TakenRequest[]) {
    this.file.running = running;
    await this.save();
  }

  /**
   * Says whether a run request is new, by the client id its sender signed: a server can post a
   * signed request again under a new message id (K-47). Checked and noted before any wait, so two
   * copies in one check-in cannot both pass. Kept on disk while a copy could still run.
   */
  remember(clientId: string, sentAt: number) {
    if (!clientId) return true;
    const handled = (this.file.handled ??= {});
    if (handled[clientId] !== undefined) return false;
    handled[clientId] = sentAt;
    const cutoff = Date.now() - REQUEST_TTL_MS;
    for (const [id, at] of Object.entries(handled)) if (at < cutoff) delete handled[id];
    this.save().catch(() => undefined);
    return true;
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
      const body: SyncRequest = { cursor: this.file.cursor, stamp: this.stamp, attentive: true, tabId: this.tabId, endpoint: null, repos: this.repos ?? undefined, protocol: this.protocol };
      const answer = await this.request<SyncResponse>('POST', '/sync', body);
      dirty ||= answer.cursor !== this.file.cursor;
      this.file.cursor = answer.cursor;
      this.stamp = answer.stamp;
      if (!answer.changed) break;
      this.users = new Map(answer.users.map((u) => [u.id, u]));
      this.projects = answer.projects;
      this.conversations = new Map(answer.conversations.map((c) => [c.id, c]));
      this.docs = answer.docs;
      dirty = (await this.keys.checkPins(answer.users, this.file.pins)) || dirty;
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
    const opened = await Promise.all(mine.map((m) => this.open(m)));
    let trusted = false;
    for (const m of opened) trusted = (await this.trust(m)) || trusted;
    if (trusted) await this.save();
    return opened;
  }

  /**
   * Pins the keys its owner checked on their page, so this account opens what that page opens and a
   * card's brief hashes the same on both (K-57, D-110). Only the owner's word in their direct chat,
   * only for the keys the server shows now, and only a check newer than the last one pinned. A check
   * of any age counts: Claude Code may have been closed when the owner made it. True when it pinned.
   */
  private async trust({ content, security, senderId, conversationId }: OpenedMessage) {
    const trust = content?.trust;
    const keys = trust && this.users.get(trust.user)?.keys;
    if (!keys || security !== 'encrypted' || senderId !== this.owner || this.conversations.get(conversationId)?.type !== 'direct') return false;
    const trusted = (this.file.trusted ??= {});
    if (trust.sentAt <= (trusted[trust.user] ?? 0) || trust.fingerprint !== (await keyFingerprint(keys))) return false;
    trusted[trust.user] = trust.sentAt;
    this.file.pins[trust.user] = trust.fingerprint;
    this.keys.changed.delete(trust.user);
    return true;
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

  /** A person's public keys: one's own from the file, others from the server, unless they changed. */
  keysOf = (userId: number): PublicKeysDTO | null => {
    if (userId === this.id) return this.identity.publicKeys;
    return this.keys.unchecked(userId) ? null : (this.users.get(userId)?.keys ?? null);
  };

  /**
   * The chat's current key, for sealing. A key whose copy names no chat waits for a page to replace
   * it, since the agent never makes keys (D-085, K-65).
   */
  private async currentKey(conversationId: number) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.keyId) throw new Error('Not a member of this chat, or it has no key.');
    const key = await this.keys.sealingKey(conversation, this.keysOf);
    if (!key) throw new Error('The chat has no key, or it was replaced.');
    return { keyId: conversation.keyId, key };
  }

  /** The key a message names: the current one, or an earlier one found through the key links. */
  private keyFor(conversation: ConversationDTO, keyId: string): Promise<CryptoKey> {
    return this.keys.keyFor(conversation, keyId, this.keysOf) ?? Promise.reject(new Error('No key for this message.'));
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
