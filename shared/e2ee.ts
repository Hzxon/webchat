// End-to-end encryption, built only on Web Crypto, so the same code runs in the page, the
// service worker, and Node (tests).
//
// - Password: PBKDF2 then HKDF give two unrelated values. The login key goes to the server; the
//   backup key never leaves the browser and seals the account's private keys.
// - Account keys: an ECDH pair (receives chat keys) and an ECDSA pair (signs messages), P-256.
// - Chat key: random AES-256-GCM key per chat. The creator wraps it for every member with a key
//   from static ECDH between the two of them, so a wrapped key proves who made it.
// - Message: AES-GCM with the chat key, then an ECDSA signature over the ciphertext and its
//   metadata, so no one, including other members, can alter it or send as someone else. The content
//   is padded to one of a few fixed sizes first, so the ciphertext length does not give it away.
// - New member of a project: an existing member opens their own copy of each channel key and
//   wraps it for the newcomer, who can then read the channel's history.
// - Rotation: when someone leaves or is removed, a member who stays makes a new chat key, wraps it
//   for everyone who stays, and encrypts the old key with the new one. Whoever holds the new key
//   opens every earlier key in turn; the person who left never gets the new one.
import {
  isRepoName,
  LIMITS,
  type BoardSyncDTO,
  type CardDraftDTO,
  type EnvelopeDTO,
  type MessageKind,
  type PublicKeysDTO,
  type PullCardDTO,
  type PullChecks,
  type PromptDTO,
  type PullReview,
  type RunDTO,
  type RunReport,
  type SealedBackupDTO,
} from './types.js';

/** PBKDF2 rounds: OWASP's 2023 figure for PBKDF2-HMAC-SHA256. Changing it changes every derived key. */
export const KDF_ITERATIONS = 600_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

export function toBase64Url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const randomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));

async function sha(algorithm: 'SHA-256' | 'SHA-512', data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await subtle().digest(algorithm, data));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Password

export interface AccountSecrets {
  /** Sent to the server instead of the password. Knowing it does not reveal the backup key. */
  authKey: string;
  /** Seals and opens the private-key backup. Never leaves the browser. */
  backupKey: CryptoKey;
}

/**
 * Stretches the password once (the slow part), then splits it with HKDF. The salt mixes a random
 * per-deployment value with the username, so the same password gives different keys per account.
 */
export async function deriveAccountSecrets(
  password: string,
  username: string,
  kdfSalt: string,
  iterations = KDF_ITERATIONS,
): Promise<AccountSecrets> {
  const salt = await sha('SHA-256', utf8(`webchat/kdf/v1|${kdfSalt}|${username.trim().toLowerCase()}`));
  const passwordKey = await subtle().importKey('raw', utf8(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const stretched = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passwordKey, 256);
  const master = await subtle().importKey('raw', stretched, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) });
  const authKey = await subtle().deriveBits(hkdf('webchat/auth/v1'), master, 256);
  const backupKey = await subtle().deriveKey(hkdf('webchat/backup/v1'), master, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  return { authKey: toBase64Url(authKey), backupKey };
}

// ---------------------------------------------------------------------------------------------
// Account keys

/** Private keys as base64url PKCS#8, plus the matching public keys. Exists only inside a backup. */
export interface IdentitySecrets {
  dh: string;
  sign: string;
  publicKeys: PublicKeysDTO;
}

/** Ready-to-use account keys. The private keys cannot be exported once imported this way. */
export interface Identity {
  dhPrivate: CryptoKey;
  signPrivate: CryptoKey;
  publicKeys: PublicKeysDTO;
}

export async function createIdentity(): Promise<IdentitySecrets> {
  const dh = await subtle().generateKey(ECDH, true, ['deriveBits']);
  const sign = await subtle().generateKey(ECDSA, true, ['sign', 'verify']);
  return {
    dh: toBase64Url(await subtle().exportKey('pkcs8', dh.privateKey)),
    sign: toBase64Url(await subtle().exportKey('pkcs8', sign.privateKey)),
    publicKeys: {
      dh: toBase64Url(await subtle().exportKey('raw', dh.publicKey)),
      sign: toBase64Url(await subtle().exportKey('raw', sign.publicKey)),
    },
  };
}

const BACKUP_AAD = utf8('webchat/backup/v1');

export async function sealIdentity(secrets: IdentitySecrets, backupKey: CryptoKey): Promise<SealedBackupDTO> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: BACKUP_AAD },
    backupKey,
    utf8(JSON.stringify(secrets)),
  );
  return { iv: toBase64Url(iv), data: toBase64Url(data) };
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password.');
    this.name = 'WrongPasswordError';
  }
}

/** Opens a backup. A wrong password fails the AES-GCM check and throws WrongPasswordError. */
export async function openIdentity(backup: SealedBackupDTO, backupKey: CryptoKey): Promise<IdentitySecrets> {
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(backup.iv), additionalData: BACKUP_AAD },
      backupKey,
      fromBase64Url(backup.data),
    );
  } catch {
    throw new WrongPasswordError();
  }
  return JSON.parse(decoder.decode(plain)) as IdentitySecrets;
}

/**
 * Imports the private keys as non-exportable and checks that they match the public keys stored
 * with them, so a backup with swapped public keys is rejected.
 */
export async function importIdentity(secrets: IdentitySecrets): Promise<Identity> {
  const dhPrivate = await subtle().importKey('pkcs8', fromBase64Url(secrets.dh), ECDH, false, ['deriveBits']);
  const signPrivate = await subtle().importKey('pkcs8', fromBase64Url(secrets.sign), ECDSA, false, ['sign']);

  const probe = utf8('webchat/identity-check');
  const signature = await subtle().sign(SIGN, signPrivate, probe);
  const signPublic = await subtle().importKey('raw', fromBase64Url(secrets.publicKeys.sign), ECDSA, false, ['verify']);
  const ephemeral = await subtle().generateKey(ECDH, false, ['deriveBits']);
  const ours = await subtle().deriveBits({ name: 'ECDH', public: ephemeral.publicKey }, dhPrivate, 256);
  const theirs = await subtle().deriveBits(
    { name: 'ECDH', public: await importDhPublic(secrets.publicKeys.dh) },
    ephemeral.privateKey,
    256,
  );
  if (!(await subtle().verify(SIGN, signPublic, signature, probe)) || toBase64Url(ours) !== toBase64Url(theirs)) {
    throw new Error('The stored public keys do not match the private keys.');
  }
  return { dhPrivate, signPrivate, publicKeys: secrets.publicKeys };
}

const importDhPublic = (key: string) => subtle().importKey('raw', fromBase64Url(key), ECDH, false, []);

// ---------------------------------------------------------------------------------------------
// Chat keys

export const newKeyId = () => toBase64Url(randomBytes(16));
export const newChatKeyBytes = () => randomBytes(32);

export const importChatKey = (raw: Uint8Array<ArrayBuffer>) =>
  subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

/** The secret two people share, from which the keys that wrap chat keys between them come. */
async function pairSecret(myDhPrivate: CryptoKey, theirDhPublic: string) {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await importDhPublic(theirDhPublic) }, myDhPrivate, 256);
  return subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
}

/**
 * What a key that wraps a chat key names: the chat, so the server cannot hand a copy made for one
 * chat out as another chat's key (D-111), and who wrapped it for whom.
 */
const pairInfo = (conversationId: number, from: number, to: number) => `webchat/chat-key/v2|conv:${conversationId}|from:${from}|to:${to}`;

/** The key that wraps a chat key between two people. Both sides derive the same one. */
const pairKey = (secret: CryptoKey, keyId: string, info: string) =>
  subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(keyId), info: utf8(info) },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

export interface WrappedKey {
  iv: string;
  data: string;
}

export async function wrapChatKey(
  raw: Uint8Array<ArrayBuffer>,
  me: { id: number; identity: Identity },
  member: { id: number; dh: string },
  keyId: string,
  conversationId: number,
): Promise<WrappedKey> {
  const key = await pairKey(await pairSecret(me.identity.dhPrivate, member.dh), keyId, pairInfo(conversationId, me.id, member.id));
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(keyId) }, key, raw);
  return { iv: toBase64Url(iv), data: toBase64Url(data) };
}

/**
 * The raw bytes of a chat key, to wrap it again for a new member. Throws unless the named
 * wrapper's key really made it for this user, in this chat or before copies named their chat.
 * `namesChat` is false for a copy from before D-111, which the server could have taken from another
 * chat between the same two people, so its key never seals (K-65).
 */
export async function openChatKeyBytes(
  wrapped: WrappedKey,
  me: { id: number; identity: Identity },
  wrapper: { id: number; dh: string },
  keyId: string,
  conversationId: number,
): Promise<{ raw: Uint8Array<ArrayBuffer>; namesChat: boolean }> {
  const secret = await pairSecret(me.identity.dhPrivate, wrapper.dh);
  const open = async (info: string) =>
    new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(wrapped.iv), additionalData: utf8(keyId) },
        await pairKey(secret, keyId, info),
        fromBase64Url(wrapped.data),
      ),
    );
  return open(pairInfo(conversationId, wrapper.id, me.id)).then(
    (raw) => ({ raw, namesChat: true }),
    async () => ({ raw: await open(`webchat/chat-key/v1|from:${wrapper.id}|to:${me.id}`), namesChat: false }),
  );
}

/** Unwraps a chat key. Throws unless the named wrapper's key really made it for this user, in this chat. */
export async function unwrapChatKey(
  wrapped: WrappedKey,
  me: { id: number; identity: Identity },
  wrapper: { id: number; dh: string },
  keyId: string,
  conversationId: number,
): Promise<CryptoKey> {
  return importChatKey((await openChatKeyBytes(wrapped, me, wrapper, keyId, conversationId)).raw);
}

// A link is bound to its chat and to both key ids, so the server cannot move it to another chat
// or splice the chain in a different order.
const linkData = (conversationId: number, keyId: string, previousKeyId: string) =>
  utf8(`webchat/key-link/v1|conv:${conversationId}|kid:${keyId}|prev:${previousKeyId}`);

/** Encrypts a chat's current key with the new key that replaces it. */
export async function linkChatKey(
  newKey: CryptoKey,
  keyId: string,
  conversationId: number,
  previous: Uint8Array<ArrayBuffer>,
  previousKeyId: string,
): Promise<WrappedKey> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: linkData(conversationId, keyId, previousKeyId) },
    newKey,
    previous,
  );
  return { iv: toBase64Url(iv), data: toBase64Url(data) };
}

/** Opens the key that keyId replaced. Throws if the link was changed, or belongs to another chat or key. */
export async function openKeyLink(
  newKey: CryptoKey,
  keyId: string,
  conversationId: number,
  link: WrappedKey,
  previousKeyId: string,
): Promise<CryptoKey> {
  const raw = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(link.iv), additionalData: linkData(conversationId, keyId, previousKeyId) },
    newKey,
    fromBase64Url(link.data),
  );
  return importChatKey(new Uint8Array(raw));
}

// ---------------------------------------------------------------------------------------------
// Messages

/** Everything about a message the server could tamper with. It is bound into every envelope. */
export interface MessageMeta {
  conversationId: number;
  senderId: number;
  urgent: boolean;
  clientId: string;
  /** Missing means "message". */
  kind?: MessageKind;
}

/** The message a reply answers, with a short copy of its text in case the original is not loaded. */
export interface QuotedMessage {
  id: number;
  /** 0 for a card the server wrote from GitHub, which has no sender. */
  senderId: number;
  text: string;
}

/** What an envelope holds. Messages from before replies and reactions hold only text. */
export interface MessageContent {
  text: string;
  replyTo?: QuotedMessage;
  /**
   * For kind "reaction": the message and the emoji. An empty emoji takes the reaction back. The
   * server picks message ids and no signature covers them, so a reaction also names its target's
   * sender (0 for a card from GitHub) and client id, which the target's header signs (K-44, D-109).
   * Reactions from before that have neither.
   */
  reaction?: { messageId: number; emoji: string; senderId?: number; clientId?: string };
  /** A shared pull request. The text holds the same in words, for pages and devices without the card. */
  pull?: PullCardDTO;
  /** A card handed to a coding agent, or the agent's report on it. The text says the same in words. */
  run?: RunDTO;
  /** A message of a conversation between an owner and their agent (D-102). */
  prompt?: PromptDTO;
  /**
   * The owner's note that their page added the card draft it names to the board, so every device of
   * theirs knows (D-104). Outside `prompt`, which the agent would take as a reply.
   */
  added?: { to: string; draft: string; card: string };
  /** The owner has their agent forget its folder of a repository: the mark goes, never the files (R-038, D-101). */
  forget?: { repo: string; sentAt: number };
  /**
   * The owner checked a person's security code, so their agents pin the same keys and open what the
   * page opens: a card's brief hashes the same on both sides (K-57, D-110).
   */
  trust?: { user: number; fingerprint: string; sentAt: number };
  /** The owner puts their agent to sleep from the pane; only `/webchat:wake` on the laptop wakes it (K-66, D-113). */
  sleep?: { sentAt: number };
  /** The board's copy in a linked repository, between the owner's page and their agent (R-040, D-117). */
  board?: BoardSyncDTO;
}

/** The longest emoji a reaction may carry, in UTF-16 units: family and flag sequences fit. */
const EMOJI_LENGTH = 32;

/**
 * The smallest size the content is padded to, in bytes. Every size above it is the next power of
 * two, so the server learns only which of a few bands a message falls in, and a reaction, a
 * take-back and a short message all look the same. Doubling keeps the bands few; the largest
 * message fits in 32 KB (LIMITS.ciphertextLength).
 */
export const PAD_MIN_BYTES = 256;

// The padding is one 0x80 byte and then zeros (ISO/IEC 7816-4). The content is JSON, which ends
// with "}" and never holds a raw zero byte, so content from before padding is told apart by its
// last byte and still opens.
const PAD_MARK = 0x80;

/** Pads the content to the smallest band that holds it and the mark. */
export function padContent(plain: Uint8Array): Uint8Array<ArrayBuffer> {
  let size = PAD_MIN_BYTES;
  while (size < plain.length + 1) size *= 2;
  const out = new Uint8Array(size);
  out.set(plain);
  out[plain.length] = PAD_MARK;
  return out;
}

/** Strips the padding. Content from before padding is returned as it is. */
export function unpadContent(plain: Uint8Array): Uint8Array {
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (end === 0 || plain[end - 1] !== PAD_MARK) return plain;
  return plain.subarray(0, end - 1);
}

// Plain messages keep the original header, so their signatures from before kinds existed still check.
const header = (meta: MessageMeta, keyId: string) =>
  `webchat/msg/v1|conv:${meta.conversationId}|kid:${keyId}|from:${meta.senderId}|urgent:${meta.urgent ? 1 : 0}|cid:${meta.clientId}` +
  (meta.kind && meta.kind !== 'message' ? `|kind:${meta.kind}` : '');

/** Pads and encrypts JSON content under a header, then signs the header with the ciphertext. */
async function seal(chatKey: CryptoKey, keyId: string, signPrivate: CryptoKey, head: string, content: object): Promise<EnvelopeDTO> {
  const iv = toBase64Url(randomBytes(12));
  const ct = toBase64Url(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: utf8(head) },
      chatKey,
      padContent(utf8(JSON.stringify(content))),
    ),
  );
  const sig = toBase64Url(await subtle().sign(SIGN, signPrivate, utf8(`${head}|iv:${iv}|ct:${ct}`)));
  return { v: 1, kid: keyId, iv, ct, sig };
}

export function encryptMessage(
  chatKey: CryptoKey,
  keyId: string,
  signPrivate: CryptoKey,
  meta: MessageMeta,
  content: string | MessageContent,
): Promise<EnvelopeDTO> {
  return seal(chatKey, keyId, signPrivate, header(meta, keyId), typeof content === 'string' ? { text: content } : content);
}

export class TamperedMessageError extends Error {
  constructor(reason: string) {
    super(`Message rejected: ${reason}`);
    this.name = 'TamperedMessageError';
  }
}

const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

const REVIEWS = new Set<PullReview>(['approved', 'changes_requested', 'review_required']);
const CHECKS = new Set<PullChecks>(['success', 'failure', 'pending']);
/** A GitHub login, or a team as "org/team". */
const PERSON = /^[^\s/]{1,100}(\/[^\s/]{1,100})?$/;

/** Reviewers or assignees, if they are a list. A card without one keeps it absent: it is not known, not empty. */
function readPeople(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return;
  return raw.filter((p): p is string => typeof p === 'string' && PERSON.test(p)).slice(0, LIMITS.pullPeople);
}

/**
 * A pull request card, if it has the right shape. The link is rebuilt from the repository and
 * number, so a card can only ever lead to that pull request on github.com.
 */
export function readPull(raw: Partial<PullCardDTO> | undefined): PullCardDTO | undefined {
  if (!raw || typeof raw.repo !== 'string' || !isRepoName(raw.repo) || !isId(raw.number) || typeof raw.title !== 'string') return;
  const url = `https://github.com/${raw.repo}/pull/${raw.number}`;
  if (raw.url !== url) return;
  const card: PullCardDTO = {
    repo: raw.repo,
    number: raw.number,
    title: raw.title.slice(0, LIMITS.pullTitleLength),
    url,
    draft: raw.draft === true,
    review: REVIEWS.has(raw.review as PullReview) ? (raw.review as PullReview) : null,
    checks: CHECKS.has(raw.checks as PullChecks) ? (raw.checks as PullChecks) : null,
    conflicts: raw.conflicts === true,
  };
  const reviewers = readPeople(raw.reviewers);
  if (reviewers) card.reviewers = reviewers;
  const assignees = readPeople(raw.assignees);
  if (assignees) card.assignees = assignees;
  return card;
}

const CARD_ID = /^[DRKQ]-\d{1,6}$/;
const REPORT_KINDS: ReadonlyArray<RunReport['kind']> = ['claimed', 'done', 'failed', 'fixing', 'review', 'ended', 'nocopy', 'stale', 'decision', 'merged', 'draft'];
const short = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : undefined);

/** A run request or report, if it has the right shape. A pull request is named by repository and number only. */
export function readRun(raw: Record<string, unknown> | undefined): RunDTO | undefined {
  if (!raw) return;
  if (raw.kind === 'request') {
    const card = short(raw.card, 8);
    const title = short(raw.title, LIMITS.runNoteLength);
    const docId = short(raw.docId, 64);
    const section = short(raw.section, 64);
    if (!card || !CARD_ID.test(card) || title === undefined || !docId || !section || !isId(raw.runtime)) return;
    return {
      kind: 'request',
      card,
      title,
      docId,
      section,
      runtime: raw.runtime,
      ...(isId(raw.sentAt) && { sentAt: raw.sentAt }),
      ...(typeof raw.repo === 'string' && isRepoName(raw.repo) && { repo: raw.repo }),
      ...(short(raw.hash, 64) && { hash: raw.hash as string }),
      ...(short(raw.was, LIMITS.runNoteLength) !== undefined && { was: raw.was as string }),
    };
  }
  if (raw.kind === 'cancel') return isId(raw.request) ? { kind: 'cancel', request: raw.request } : undefined;
  if (raw.kind === 'fix') {
    if (!isId(raw.request) || !isId(raw.sentAt)) return;
    const note = short(raw.note, LIMITS.messageLength);
    return { kind: 'fix', request: raw.request, sentAt: raw.sentAt, ...(note && { note }), ...(isId(raw.review) && { review: raw.review }) };
  }
  if (raw.kind === 'clone') {
    return isId(raw.request) && isId(raw.sentAt) && typeof raw.repo === 'string' && isRepoName(raw.repo) ? { kind: 'clone', request: raw.request, repo: raw.repo, sentAt: raw.sentAt } : undefined;
  }
  const kind = REPORT_KINDS.find((k) => k === raw.kind);
  if (!kind || !isId(raw.request)) return;
  const run: RunReport = { kind, request: raw.request };
  const note = short(raw.note, LIMITS.runNoteLength);
  if (note) run.note = note;
  const branch = short(raw.branch, LIMITS.branchLength);
  if (branch) run.branch = branch;
  const pull = raw.pull as { repo?: unknown; number?: unknown } | undefined;
  if (typeof pull?.repo === 'string' && isRepoName(pull.repo) && isId(pull.number)) run.pull = { repo: pull.repo, number: pull.number };
  const card = readDraft(raw.card as Record<string, unknown> | undefined);
  if (card) run.card = card;
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.filter((d): d is string => typeof d === 'string' && /^D-\d{1,6}$/.test(d)) : [];
  if (decisions.length) run.decisions = decisions.slice(0, LIMITS.relatedPerDraft);
  return run;
}

/** A conversation's message, if it has the right shape. */
export function readPrompt(raw: Record<string, unknown> | undefined): PromptDTO | undefined {
  if (raw?.kind === 'prompt') {
    // A project with no repository asks about its board alone (R-038).
    const repo = typeof raw.repo === 'string' && isRepoName(raw.repo) ? raw.repo : undefined;
    if ((raw.repo !== undefined && !repo) || (!repo && !isId(raw.project)) || !isId(raw.sentAt)) return;
    return { kind: 'prompt', sentAt: raw.sentAt, ...(repo && { repo }), ...(isId(raw.project) && { project: raw.project }) };
  }
  const to = short(raw?.to, 64);
  if (!raw || !to) return;
  if (raw.kind === 'reply' || raw.kind === 'cancel') return isId(raw.sentAt) ? { kind: raw.kind, to, sentAt: raw.sentAt } : undefined;
  if (raw.kind === 'failed' || raw.kind === 'nocopy' || raw.kind === 'note') return { kind: raw.kind, to };
  if (raw.kind === 'clone') return typeof raw.repo === 'string' && isRepoName(raw.repo) && isId(raw.sentAt) ? { kind: 'clone', to, repo: raw.repo, sentAt: raw.sentAt } : undefined;
  if (raw.kind !== 'answer') return;
  const card = readDraft(raw.card as Record<string, unknown> | undefined);
  return card ? { kind: 'answer', to, card } : { kind: 'answer', to };
}

/** A card draft in an agent's answer, if it has the right shape (D-104, D-116). */
function readDraft(raw: Record<string, unknown> | undefined): CardDraftDTO | undefined {
  const title = short(raw?.title, LIMITS.docTitleLength);
  const body = short(raw?.body, LIMITS.messageLength);
  // A line break in the title would write a status line of its own into the card.
  if (!raw || (raw.kind !== 'D' && raw.kind !== 'R' && raw.kind !== 'K' && raw.kind !== 'Q') || !title || /[\r\n]/.test(title) || body === undefined) return;
  // A line break in the check would end the card's Checked line, and one in a status would write a line of its own.
  const checked = short(raw.checked, LIMITS.checkedLength);
  const status = short(raw.status, LIMITS.checkedLength);
  const related = (Array.isArray(raw.related) ? (raw.related as Array<Record<string, unknown> | null>) : []).flatMap((r) => {
    const why = short(r?.why, LIMITS.relatedWhyLength);
    const kind = r?.kind === 'duplicate' || r?.kind === 'conflict' ? (r.kind as 'duplicate' | 'conflict') : undefined;
    return typeof r?.id === 'string' && (CARD_ID.test(r.id) || /^#\d{1,7}$/.test(r.id)) && kind && why !== undefined ? [{ id: r.id, kind, why }] : [];
  });
  const draft: CardDraftDTO = {
    kind: raw.kind,
    title,
    body,
    ...(checked && !/[\r\n]/.test(checked) && { checked }),
    ...(related.length && { related: related.slice(0, LIMITS.relatedPerDraft) }),
    ...(status && !/[\r\n]/.test(status) && { status }),
  };
  const replaces = raw.replaces as Record<string, unknown> | undefined;
  if (!replaces) return draft;
  const card = typeof replaces.card === 'string' && CARD_ID.test(replaces.card) ? replaces.card : undefined;
  const [doc, section, seen] = [short(replaces.doc, 64), short(replaces.section, 64), short(replaces.seen, 64)];
  return card && doc && section && seen ? { ...draft, replaces: { card, doc, section, seen } } : undefined;
}

/** A message of the board's copy in a repository, if it has the right shape (R-040). */
function readBoardSync(raw: Record<string, unknown> | undefined): BoardSyncDTO | undefined {
  const repo = typeof raw?.repo === 'string' && isRepoName(raw.repo) ? raw.repo : undefined;
  const to = short(raw?.to, 64);
  if (raw?.kind === 'link') return isId(raw.project) && repo && isId(raw.sentAt) ? { kind: 'link', project: raw.project, repo, sentAt: raw.sentAt } : undefined;
  if (raw?.kind === 'failed') return to ? { kind: 'failed', to } : undefined;
  if (raw?.kind === 'entries') {
    const entries = Array.isArray(raw.entries) ? raw.entries.filter((e): e is string => typeof e === 'string' && e.length <= LIMITS.docSectionLength) : [];
    return to && isId(raw.part) && isId(raw.parts) && raw.part <= raw.parts ? { kind: 'entries', to, part: raw.part, parts: raw.parts, entries } : undefined;
  }
  if (raw?.kind === 'proposal') {
    const card = readDraft(raw.card as Record<string, unknown> | undefined);
    return isId(raw.project) && repo && card ? { kind: 'proposal', project: raw.project, repo, card } : undefined;
  }
  if (raw?.kind === 'claims' && isId(raw.project) && repo && Array.isArray(raw.claims)) {
    const claims = (raw.claims as Array<{ card?: unknown; pull?: unknown } | null>).flatMap((c) =>
      typeof c?.card === 'string' && CARD_ID.test(c.card) && isId(c.pull) ? [{ card: c.card, pull: c.pull }] : [],
    );
    return { kind: 'claims', project: raw.project, repo, claims: claims.slice(0, 100) };
  }
}

/** Keeps the parts of decrypted content that have the right shape. The sender signed it, so it is not tampered. */
function readContent(value: unknown): MessageContent {
  const raw = value as {
    text?: unknown;
    replyTo?: Partial<QuotedMessage>;
    reaction?: { messageId?: unknown; emoji?: unknown; senderId?: unknown; clientId?: unknown };
    pull?: Partial<PullCardDTO>;
    run?: Record<string, unknown>;
    prompt?: Record<string, unknown>;
    added?: Record<string, unknown>;
    forget?: { repo?: unknown; sentAt?: unknown };
    trust?: { user?: unknown; fingerprint?: unknown; sentAt?: unknown };
    sleep?: { sentAt?: unknown };
    board?: Record<string, unknown>;
  } | null;
  if (typeof raw?.text !== 'string') throw new TamperedMessageError('malformed content');
  const content: MessageContent = { text: raw.text };
  const quote = raw.replyTo;
  if (quote && isId(quote.id) && (isId(quote.senderId) || quote.senderId === 0) && typeof quote.text === 'string') {
    content.replyTo = { id: quote.id, senderId: quote.senderId, text: quote.text.slice(0, LIMITS.quoteLength) };
  }
  const reaction = raw.reaction;
  if (reaction && isId(reaction.messageId) && typeof reaction.emoji === 'string' && reaction.emoji.length <= EMOJI_LENGTH) {
    content.reaction = { messageId: reaction.messageId, emoji: reaction.emoji };
    if (isId(reaction.senderId) || reaction.senderId === 0) content.reaction.senderId = reaction.senderId;
    if (typeof reaction.clientId === 'string') content.reaction.clientId = reaction.clientId;
  }
  const pull = readPull(raw.pull);
  if (pull) content.pull = pull;
  const run = readRun(raw.run);
  if (run) content.run = run;
  const prompt = readPrompt(raw.prompt);
  if (prompt) content.prompt = prompt;
  const [to, draft, card] = [short(raw.added?.to, 64), short(raw.added?.draft, 64), short(raw.added?.card, 16)];
  if (to && draft && card) content.added = { to, draft, card };
  if (typeof raw.forget?.repo === 'string' && isRepoName(raw.forget.repo) && isId(raw.forget.sentAt)) content.forget = { repo: raw.forget.repo, sentAt: raw.forget.sentAt };
  const fingerprint = short(raw.trust?.fingerprint, 64);
  if (isId(raw.trust?.user) && fingerprint && isId(raw.trust.sentAt)) content.trust = { user: raw.trust.user, fingerprint, sentAt: raw.trust.sentAt };
  if (isId(raw.sleep?.sentAt)) content.sleep = { sentAt: raw.sleep.sentAt };
  const board = readBoardSync(raw.board);
  if (board) content.board = board;
  return content;
}

/** Checks the sender's signature, then decrypts. Throws TamperedMessageError if anything was changed. */
export async function decryptMessage(
  chatKey: CryptoKey,
  senderSignPublic: string,
  meta: MessageMeta,
  envelope: EnvelopeDTO,
): Promise<string> {
  return (await decryptContent(chatKey, senderSignPublic, meta, envelope)).text;
}

/** Like decryptMessage, with the reply and reaction parts too. */
export async function decryptContent(
  chatKey: CryptoKey,
  senderSignPublic: string,
  meta: MessageMeta,
  envelope: EnvelopeDTO,
): Promise<MessageContent> {
  return readContent(await unseal(chatKey, senderSignPublic, header(meta, envelope.kid), envelope));
}

/** Checks the signature over a header and the ciphertext, then decrypts and parses the content. */
async function unseal(chatKey: CryptoKey, signPublic: string, head: string, envelope: EnvelopeDTO): Promise<unknown> {
  if (envelope.v !== 1) throw new TamperedMessageError('unknown version');
  const verifyKey = await subtle().importKey('raw', fromBase64Url(signPublic), ECDSA, false, ['verify']);
  const signed = utf8(`${head}|iv:${envelope.iv}|ct:${envelope.ct}`);
  if (!(await subtle().verify(SIGN, verifyKey, fromBase64Url(envelope.sig), signed))) {
    throw new TamperedMessageError('bad signature');
  }
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData: utf8(head) },
      chatKey,
      fromBase64Url(envelope.ct),
    );
  } catch {
    throw new TamperedMessageError('decryption failed');
  }
  return JSON.parse(decoder.decode(unpadContent(new Uint8Array(plain))));
}

// ---------------------------------------------------------------------------------------------
// Docs

/** Everything about a doc revision the server could tamper with. Its own header keeps it from passing as a message. */
export interface DocMeta {
  conversationId: number;
  authorId: number;
  docId: string;
  section: string;
}

/** What a doc revision holds: the title's text, or a section's Markdown and its place in the doc. */
export interface DocContent {
  text: string;
  /** Sections are shown in order of this number. Signed, so the server cannot reorder them. */
  pos?: number;
  /** A section someone deleted. Its earlier revisions stay in its history. */
  removed?: boolean;
  /** On a title: this doc is a column of the project board, and its sections are cards (R-021). */
  board?: 'decisions' | 'roadmap';
  /** On the Roadmap's title: the repository whose docs copy the board, which only the project's owner sets (R-040). */
  repo?: string;
}

const docHeader = (meta: DocMeta, keyId: string) =>
  `webchat/doc/v1|conv:${meta.conversationId}|kid:${keyId}|from:${meta.authorId}|doc:${meta.docId}|sec:${meta.section}`;

export const encryptDoc = (chatKey: CryptoKey, keyId: string, signPrivate: CryptoKey, meta: DocMeta, content: DocContent) =>
  seal(chatKey, keyId, signPrivate, docHeader(meta, keyId), content);

/** Checks the author's signature, then decrypts. Throws TamperedMessageError if anything was changed. */
export async function decryptDoc(chatKey: CryptoKey, authorSignPublic: string, meta: DocMeta, envelope: EnvelopeDTO): Promise<DocContent> {
  const raw = (await unseal(chatKey, authorSignPublic, docHeader(meta, envelope.kid), envelope)) as Partial<DocContent> | null;
  if (typeof raw?.text !== 'string') throw new TamperedMessageError('malformed content');
  const content: DocContent = { text: raw.text };
  if (typeof raw.pos === 'number' && Number.isFinite(raw.pos)) content.pos = raw.pos;
  if (raw.removed === true) content.removed = true;
  if (raw.board === 'decisions' || raw.board === 'roadmap') content.board = raw.board;
  if (typeof raw.repo === 'string' && isRepoName(raw.repo)) content.repo = raw.repo;
  return content;
}

// ---------------------------------------------------------------------------------------------
// Verification

/** A text's SHA-256, such as a card's as an agent saw it, so a page can tell it changed since (D-104). */
export async function textHash(text: string): Promise<string> {
  return toBase64Url(await sha('SHA-256', utf8(text)));
}

/** Hex SHA-256 of a user's public keys. Changes if and only if their keys change. */
export async function keyFingerprint(keys: PublicKeysDTO): Promise<string> {
  const digest = await sha('SHA-256', concat(fromBase64Url(keys.dh), fromBase64Url(keys.sign)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A 60-digit code for a pair of people, the same on both sides. If two friends read the same code,
 * nobody swapped their keys in between.
 */
export async function safetyCode(a: { id: number; keys: PublicKeysDTO }, b: { id: number; keys: PublicKeysDTO }) {
  const [first, second] = [a, b].sort((x, y) => x.id - y.id);
  const digest = await sha(
    'SHA-512',
    concat(
      utf8('webchat/safety/v1'),
      fromBase64Url(first!.keys.dh),
      fromBase64Url(first!.keys.sign),
      fromBase64Url(second!.keys.dh),
      fromBase64Url(second!.keys.sign),
    ),
  );
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let value = 0;
    for (let j = 0; j < 5; j++) value = value * 256 + digest[i * 5 + j]!;
    groups.push(String(value % 100_000).padStart(5, '0'));
  }
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Pairing a coding agent (R-030, D-093)

/**
 * A one-time code the owner's page shows and the owner pastes into the agent: 128 random bits, so
 * a server that sees the id and the proofs made from it cannot guess it offline. Hex in groups of
 * four, which reads aloud and types on a phone.
 */
export function newPairingCode(): string {
  const hex = Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g)!.join('-');
}

/** The code's bytes, however it was spaced or cased. Throws on anything else. */
function pairingSecret(code: string): Uint8Array<ArrayBuffer> {
  const hex = code.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('A pairing code is 32 digits and letters a to f.');
  return new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
}

/** Where the server files a pairing: a hash of the code, so the server never learns the code. */
export async function pairingId(code: string): Promise<string> {
  return toBase64Url(await sha('SHA-256', concat(utf8('webchat/pair/id/v1'), pairingSecret(code))));
}

/**
 * Binds keys to the code. The agent proves its keys to the owner's page. The page then proves the
 * owner's id and keys to the agent, together with the agent's, so the server can swap neither.
 */
export async function pairingProof(code: string, agent: PublicKeysDTO, owner?: { id: number; keys: PublicKeysDTO }): Promise<string> {
  const key = await subtle().importKey('raw', pairingSecret(code), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signer = owner
    ? [utf8(`webchat/pair/owner/v1:${owner.id}`), fromBase64Url(owner.keys.dh), fromBase64Url(owner.keys.sign)]
    : [utf8('webchat/pair/agent/v1')];
  return toBase64Url(await subtle().sign('HMAC', key, concat(...signer, fromBase64Url(agent.dh), fromBase64Url(agent.sign))));
}
