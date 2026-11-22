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
  type AskDTO,
  type BoardSyncDTO,
  type CardNoteDTO,
  type CardDraftDTO,
  type EnvelopeDTO,
  FILE_TYPE_LIST,
  type FileDTO,
  type HarnessState,
  type MessageKind,
  type PairingPick,
  type PermitDTO,
  type PublicKeysDTO,
  type PullCardDTO,
  type PullChecks,
  type PromptDTO,
  type SessionEventDTO,
  type SessionAboutDTO,
  type PermissionMode,
  PERMISSION_MODES,
  type CardAskDTO,
  type TerminalSessionDTO,
  type PullReview,
  type RunDTO,
  type RunReport,
  type SealedBackupDTO,
  type SetupChoice,
  type SetupState,
  SKILL_NAME,
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
  /** The owner's note that they dismissed the proposal draft it names, so it waits on no device of theirs. The agent ignores it. */
  dismissed?: { to: string };
  /** The owner has their agent forget its folder of a repository: the mark goes, never the files (R-038, D-101). */
  forget?: { repo: string; sentAt: number };
  /**
   * The owner checked a person's security code, so their agents pin the same keys and open what the
   * page opens: a card's brief hashes the same on both sides (K-57, D-110).
   */
  trust?: { user: number; fingerprint: string; sentAt: number };
  /** The owner puts their agent to sleep from the pane; only `webchat-agent wake` on the laptop wakes it (K-66, D-113). */
  sleep?: { sentAt: number };
  /** The owner has their agent open a folder window on its laptop; the folder picked becomes a connect request they approve (docs/decisions/connect-approval.md). */
  pick?: { sentAt: number };
  /**
   * The owner asks their agent what its runs load from their Claude setup, and with a choice,
   * changes it (R-039, D-115). The agent answers with `setupState`, in their direct chat.
   */
  setup?: { sentAt: number; choice?: SetupChoice };
  setupState?: SetupState;
  /** The board's copy in a linked repository, between the owner's page and their agent (R-040, D-117). */
  board?: BoardSyncDTO;
  /** A request from the owner's laptop that the owner approves, and their answer (docs/decisions/harness-linking.md). */
  ask?: AskDTO;
  /** A request about a board card to the member asked (the card-notes decision). The text says the same in words. */
  card?: CardNoteDTO;
  /** An agent's question before an action, and its owner's answer (docs/decisions/harness-approvals.md). */
  permit?: PermitDTO;
  /** A photo or file (R-005). The text says the same in words, for older pages, pushes and the chat list. */
  file?: FileDTO;
  /** The owner asks for the sessions a terminal started in a connected folder, and the agent's list (R-072). */
  sessions?: { repo: string; sentAt: number };
  sessionList?: { to: string; repo: string; harness: string; sessions: TerminalSessionDTO[] };
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
const REPORT_KINDS: ReadonlyArray<RunReport['kind']> = ['claimed', 'done', 'failed', 'fixing', 'review', 'ended', 'nocopy', 'stale', 'decision', 'merged', 'closed', 'draft', 'progress', 'paused', 'planned', 'note', 'overlap'];
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
      ...(short(raw.harness, LIMITS.harnessFieldLength) && { harness: raw.harness as string }),
      ...(raw.asks === true && { asks: true as const }),
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
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.filter((d): d is string => typeof d === 'string' && CARD_ID.test(d) && d.startsWith('D-')) : [];
  if (decisions.length) run.decisions = decisions.slice(0, LIMITS.relatedPerDraft);
  const waits = short(raw.waits, 8);
  if (waits && (CARD_ID.test(waits) || /^#\d{1,7}$/.test(waits))) run.waits = waits;
  return run;
}

/** A conversation's message, if it has the right shape. */
export function readPrompt(raw: Record<string, unknown> | undefined): PromptDTO | undefined {
  if (raw?.kind === 'prompt') {
    // A project with no repository asks about its board alone (R-038); with neither, it asks in an empty folder.
    const repo = typeof raw.repo === 'string' && isRepoName(raw.repo) ? raw.repo : undefined;
    if ((raw.repo !== undefined && !repo) || !isId(raw.sentAt)) return;
    const harness = short(raw.harness, LIMITS.harnessFieldLength);
    return { kind: 'prompt', sentAt: raw.sentAt, ...(repo && { repo }), ...(isId(raw.project) && { project: raw.project }), ...(harness && { harness }), ...(raw.asks === true && { asks: true as const }), ...(raw.own === true && { own: true as const }), ...(raw.events === true && { events: true as const }), ...readCardAsk(raw.card), ...readControls(raw), ...(typeof raw.resume === 'string' && SESSION_ID.test(raw.resume) && { resume: raw.resume }) };
  }
  const to = short(raw?.to, 64);
  if (!raw || !to) return;
  if (raw.kind === 'reply') {
    const handover = raw.handover as { harness?: unknown; summary?: unknown } | undefined;
    const harness = short(handover?.harness, LIMITS.harnessFieldLength);
    const summary = short(handover?.summary, LIMITS.messageLength);
    return isId(raw.sentAt) ? { kind: raw.kind, to, sentAt: raw.sentAt, ...readCardAsk(raw.card), ...readControls(raw), ...(harness && { handover: { harness, ...(summary !== undefined && { summary }) } }) } : undefined;
  }
  if (raw.kind === 'summary') {
    const harness = short(raw.harness, LIMITS.harnessFieldLength);
    return harness ? { kind: 'summary', to, harness } : undefined;
  }
  if (raw.kind === 'cancel') return isId(raw.sentAt) ? { kind: raw.kind, to, sentAt: raw.sentAt } : undefined;
  if (raw.kind === 'failed' || raw.kind === 'nocopy' || raw.kind === 'note') return { kind: raw.kind, to };
  if (raw.kind === 'events') {
    const about = readAbout(raw.about);
    return { kind: 'events', to, events: readEvents(raw.events), ...(about && { about }) };
  }
  if (raw.kind === 'clone') return typeof raw.repo === 'string' && isRepoName(raw.repo) && isId(raw.sentAt) ? { kind: 'clone', to, repo: raw.repo, sentAt: raw.sentAt } : undefined;
  if (raw.kind !== 'answer') return;
  const card = readDraft(raw.card as Record<string, unknown> | undefined);
  return card ? { kind: 'answer', to, card } : { kind: 'answer', to };
}

/** A model's name, as a harness's command line takes it (R-072). */
export const MODEL_NAME = /^[\w.:[\]-]{1,64}$/;

/** An effort level's name, as a harness takes it, such as `high`. */
export const EFFORT_NAME = /^[a-z]{1,16}$/;

/** Each model's effort levels of the right shape, `''` for the default model, or nothing. */
export function readEfforts(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const entries = Object.entries(raw as Record<string, unknown>)
    .slice(0, 21)
    .flatMap(([model, list]) => ((model === '' || MODEL_NAME.test(model)) && Array.isArray(list) ? [[model, list.filter((e): e is string => typeof e === 'string' && EFFORT_NAME.test(e)).slice(0, 10)] as const] : []))
    .filter(([, list]) => list.length);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A harness's session id, as Claude Code names its sessions (R-072). */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A terminal's sessions of the right shape, at most `max` (R-072). */
export function readTerminalSessions(raw: unknown, max = 10): TerminalSessionDTO[] {
  return (Array.isArray(raw) ? (raw as Array<Record<string, unknown> | null>) : []).slice(0, max).flatMap((s) =>
    typeof s?.id === 'string' && SESSION_ID.test(s.id) && typeof s.title === 'string' && isId(s.at) ? [{ id: s.id, title: s.title.slice(0, LIMITS.eventTitleLength), at: s.at }] : [],
  );
}

/** A session's model, effort and permission mode, of the right shape, as the fields that carry them (R-072). */
function readControls(raw: Record<string, unknown>): { model?: string; effort?: string; mode?: PermissionMode } {
  const model = typeof raw.model === 'string' && MODEL_NAME.test(raw.model) ? raw.model : undefined;
  const effort = typeof raw.effort === 'string' && EFFORT_NAME.test(raw.effort) ? raw.effort : undefined;
  const mode = PERMISSION_MODES.find((m) => m === raw.mode);
  return { ...(model && { model }), ...(effort && { effort }), ...(mode && { mode }) };
}

/** A card mark of the right shape, as the field that carries it, or nothing (R-071). */
function readCardAsk(raw: unknown): { card?: CardAskDTO } {
  const card = raw as { kind?: unknown; title?: unknown; body?: unknown } | null | undefined;
  const title = short(card?.title, LIMITS.docTitleLength);
  const body = short(card?.body, LIMITS.docSectionLength);
  return (card?.kind === 'R' || card?.kind === 'K' || card?.kind === 'D') && title !== undefined && body !== undefined ? { card: { kind: card.kind, title, body } } : {};
}

const EVENT_KINDS: ReadonlyArray<SessionEventDTO['kind']> = ['thinking', 'read', 'search', 'command', 'edit', 'tool', 'text', 'plan'];

/** What a session runs with, the fields of the right shape (R-072). */
export function readAbout(raw: unknown): SessionAboutDTO | undefined {
  const a = raw as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== 'object') return;
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e7 ? (v as number) : undefined);
  const text = (v: unknown) => short(v, LIMITS.harnessFieldLength);
  const mcp = Array.isArray(a.mcp) ? a.mcp.filter((n): n is string => !!text(n)).slice(0, 50) : undefined;
  const commands = Array.isArray(a.commands) ? a.commands.filter((n): n is string => typeof n === 'string' && /^[\w:.-]{1,64}$/.test(n)).slice(0, 200) : undefined;
  const about: SessionAboutDTO = { model: text(a.model), branch: text(a.branch), own: typeof a.own === 'boolean' ? a.own : undefined, plugins: count(a.plugins), skills: count(a.skills), hooks: count(a.hooks), mcp, context: count(a.context), commands };
  return Object.fromEntries(Object.entries(about).filter(([, v]) => v !== undefined)) as SessionAboutDTO;
}

/** A session's steps of the right shape, each cut to its limits (R-072). */
export function readEvents(raw: unknown): SessionEventDTO[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown> | null>).slice(0, LIMITS.eventsPerMessage).flatMap((e) => {
    const kind = EVENT_KINDS.find((k) => k === e?.kind);
    const title = typeof e?.title === 'string' ? e.title.slice(0, LIMITS.eventTitleLength) : undefined;
    if (!kind || title === undefined || !isId(e!.at)) return [];
    const detail = typeof e!.detail === 'string' && e!.detail ? e!.detail.slice(-LIMITS.eventDetailLength) : undefined;
    return [{ kind, title, at: e!.at, ...(detail && { detail }) }];
  });
}

/** A card draft in an agent's answer, if it has the right shape (D-104, D-116). */
function readDraft(raw: Record<string, unknown> | undefined): CardDraftDTO | undefined {
  const title = short(raw?.title, LIMITS.docTitleLength);
  const body = short(raw?.body, LIMITS.docSectionLength);
  // A line break in the title would write a status line of its own into the card.
  if (!raw || (raw.kind !== 'D' && raw.kind !== 'R' && raw.kind !== 'K' && raw.kind !== 'Q') || !title || /[\r\n]/.test(title) || body === undefined) return;
  // A line break in the check would end the card's Checked line, and one in a status would write a line of its own.
  const checked = short(raw.checked, LIMITS.checkedLength);
  const status = short(raw.status, LIMITS.checkedLength);
  const after = short(raw.after, LIMITS.docTitleLength);
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
    ...(after && !/[\r\n]/.test(after) && { after }),
  };
  const replaces = raw.replaces as Record<string, unknown> | undefined;
  if (!replaces) return draft;
  const card = typeof replaces.card === 'string' && CARD_ID.test(replaces.card) ? replaces.card : undefined;
  const [doc, section, seen] = [short(replaces.doc, 64), short(replaces.section, 64), short(replaces.seen, 64)];
  return card && doc && section && seen ? { ...draft, replaces: { card, doc, section, seen } } : undefined;
}

/** A setup choice, if it has the right shape: skills only by a folder name that cannot leave `~/.claude/skills` (R-039). */
function readChoice(raw: unknown): SetupChoice | undefined {
  const choice = raw as { claudeMd?: unknown; skills?: unknown; noAttribution?: unknown; linked?: unknown; off?: unknown; noPlan?: unknown; own?: unknown } | null | undefined;
  if (typeof choice?.claudeMd !== 'boolean' || typeof choice.noAttribution !== 'boolean' || !Array.isArray(choice.skills)) return;
  const skills = choice.skills.filter((s): s is string => typeof s === 'string' && SKILL_NAME.test(s)).slice(0, LIMITS.setupSkills);
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is string => !!short(n, LIMITS.harnessFieldLength)).slice(0, LIMITS.harnesses) : undefined);
  const [linked, off, own] = [names(choice.linked), names(choice.off), names(choice.own)];
  return { claudeMd: choice.claudeMd, skills, noAttribution: choice.noAttribution, ...(linked && { linked }), ...(off && { off }), ...(typeof choice.noPlan === 'boolean' && { noPlan: choice.noPlan }), ...(own && { own }) };
}

/** The harnesses an agent's answer lists, those of the right shape, or nothing from a plugin before them (D-115). */
function readHarnesses(raw: unknown): HarnessState[] | undefined {
  if (!Array.isArray(raw)) return;
  const field = (value: unknown) => short(value, LIMITS.harnessFieldLength);
  return (raw as Array<Record<string, unknown> | null>).slice(0, LIMITS.harnesses).flatMap((h) => {
    const name = field(h?.name);
    if (!h || !name) return [];
    const knobs = Array.isArray(h.knobs) ? h.knobs.filter((k): k is string => typeof k === 'string' && /^\w{1,32}$/.test(k)) : [];
    const models = Array.isArray(h.models) ? h.models.filter((m): m is string => typeof m === 'string' && MODEL_NAME.test(m)).slice(0, 20) : undefined;
    const efforts = readEfforts(h.efforts);
    const signedIn = typeof h.signedIn === 'boolean' ? h.signedIn : undefined;
    const linked = typeof h.linked === 'boolean' ? h.linked : undefined;
    return [{ name, path: field(h.path), linked, attention: field(h.attention), answers: field(h.answers), version: field(h.version), signedIn, refusal: field(h.refusal), instructions: field(h.instructions), skills: field(h.skills), knobs, ...(models?.length && { models }), ...(efforts && { efforts }) }];
  });
}

/** An agent's answer to its owner's `setup`, if it has the right shape (R-039). */
function readSetupState(raw: Record<string, unknown> | undefined): SetupState | undefined {
  const choice = readChoice(raw?.choice);
  const to = short(raw?.to, 64);
  if (!raw || !choice || !to || typeof raw.claudeMd !== 'boolean' || !Array.isArray(raw.skills)) return;
  const skills = (raw.skills as Array<{ name?: unknown; description?: unknown } | null>).flatMap((s) =>
    typeof s?.name === 'string' && SKILL_NAME.test(s.name) ? [{ name: s.name, description: short(s.description, LIMITS.skillDescriptionLength) ?? '' }] : [],
  );
  const applied = readChoice(raw.applied);
  const at = (raw.applied as { at?: unknown } | undefined)?.at;
  const harnesses = readHarnesses(raw.harnesses);
  return { to, claudeMd: raw.claudeMd, skills: skills.slice(0, LIMITS.setupSkills), choice, ...(applied && isId(at) && { applied: { ...applied, at } }), ...(harnesses && { harnesses }) };
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

/** An ask or its answer, if it has the right shape: `to` names the request by its client id. */
function readAsk(raw: Record<string, unknown> | undefined): AskDTO | undefined {
  const kind = raw?.kind;
  if (!raw || (kind !== 'link' && kind !== 'connect')) return;
  const to = short(raw.to, 64);
  const harness = short(raw.harness, LIMITS.harnessFieldLength);
  const [repo, folder] = [short(raw.repo, 100), short(raw.folder, LIMITS.harnessFieldLength)];
  const place = repo && folder && isRepoName(repo) ? { repo, folder } : undefined;
  if (raw.step === 'request') {
    if (kind === 'link') return harness ? { kind, step: 'request', harness } : undefined;
    return place && { kind, step: 'request', ...place };
  }
  if (raw.step === 'approve' || raw.step === 'decline') {
    if (!to || !isId(raw.sentAt)) return;
    if (raw.step === 'decline' || kind === 'link') return { kind, step: raw.step, to, sentAt: raw.sentAt } as AskDTO;
    return place && { kind, step: 'approve', to, sentAt: raw.sentAt, ...place };
  }
  if (raw.step !== 'done' && raw.step !== 'failed') return;
  const note = short(raw.note, LIMITS.runNoteLength);
  return to ? { kind, step: raw.step, to, ...(note && { note }) } : undefined;
}

const PERMIT_WHAT: ReadonlyArray<Extract<PermitDTO, { kind: 'question' }>['what']> = ['run', 'edit', 'read', 'fetch', 'other'];
const PERMIT_OUTCOMES: ReadonlyArray<Extract<PermitDTO, { kind: 'settled' }>['outcome']> = ['allowed', 'allowedForRun', 'denied', 'expired', 'stopped', 'stale'];
const PERMIT_DECISIONS: ReadonlyArray<Extract<PermitDTO, { kind: 'answer' }>['decision']> = ['once', 'run', 'deny'];

/** A question, an answer or a settled mark, if it has the right shape. */
function readPermit(raw: Record<string, unknown> | undefined): PermitDTO | undefined {
  if (!raw) return;
  if (raw.kind === 'question') {
    const [request, to] = [isId(raw.request) ? raw.request : undefined, short(raw.to, 64)];
    const what = PERMIT_WHAT.find((w) => w === raw.what);
    const detail = short(raw.detail, LIMITS.messageLength);
    // One thread: a card's request or a conversation's prompt, never both or neither.
    if (!what || detail === undefined || !isId(raw.expires) || (request === undefined) === (to === undefined)) return;
    return { kind: 'question', ...(request !== undefined && { request }), ...(to && { to }), what, detail, expires: raw.expires };
  }
  const to = short(raw.to, 64);
  if (!to) return;
  if (raw.kind === 'settled') {
    const outcome = PERMIT_OUTCOMES.find((o) => o === raw.outcome);
    return outcome && { kind: 'settled', to, outcome };
  }
  const decision = PERMIT_DECISIONS.find((d) => d === raw.decision);
  const seen = short(raw.seen, 64);
  return raw.kind === 'answer' && decision && seen && isId(raw.sentAt) ? { kind: 'answer', to, decision, seen, sentAt: raw.sentAt } : undefined;
}

/** What the owner saw of a question, hashed into their answer, so an answer cannot be for another action (D-105). */
export const permitHash = (question: Extract<PermitDTO, { kind: 'question' }>) => textHash(`${question.what}\n${question.detail}`);

const NOTE_KINDS: ReadonlyArray<CardNoteDTO['kind']> = ['ready', 'review', 'waiting'];

/** A request about a board card, if it has the right shape. */
function readCardNote(raw: Record<string, unknown> | undefined): CardNoteDTO | undefined {
  const [card, docId, section] = [short(raw?.card, 8), short(raw?.docId, 64), short(raw?.section, 64)];
  const kind = NOTE_KINDS.find((k) => k === raw?.kind);
  return kind && card && CARD_ID.test(card) && docId && section ? { kind, card, docId, section } : undefined;
}

/** A file's id: 16 random bytes, base64url. */
export const FILE_ID = /^[A-Za-z0-9_-]{22}$/;
const FILE_KEY = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const isSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** A file, if it has the right shape: a type on the list, and a preview that is only an inline image. */
function readFile(raw: Record<string, unknown> | undefined): FileDTO | undefined {
  const [id, key, name, type] = [raw?.id, raw?.key, short(raw?.name, LIMITS.fileNameLength), raw?.type];
  if (typeof id !== 'string' || !FILE_ID.test(id) || typeof key !== 'string' || !FILE_KEY.test(key) || !name) return;
  if (typeof type !== 'string' || !FILE_TYPE_LIST.includes(type) || !isSize(raw?.size) || raw.size > LIMITS.fileBytes) return;
  const file: FileDTO = { id, key, name, type, size: raw.size };
  if (isSize(raw.width) && isSize(raw.height)) Object.assign(file, { width: raw.width, height: raw.height });
  const preview = short(raw.preview, LIMITS.previewLength);
  if (preview && PREVIEW.test(preview)) file.preview = preview;
  return file;
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
    dismissed?: Record<string, unknown>;
    forget?: { repo?: unknown; sentAt?: unknown };
    trust?: { user?: unknown; fingerprint?: unknown; sentAt?: unknown };
    sleep?: { sentAt?: unknown };
    pick?: { sentAt?: unknown };
    setup?: { sentAt?: unknown; choice?: unknown };
    setupState?: Record<string, unknown>;
    board?: Record<string, unknown>;
    ask?: Record<string, unknown>;
    card?: Record<string, unknown>;
    permit?: Record<string, unknown>;
    file?: Record<string, unknown>;
    sessions?: { repo?: unknown; sentAt?: unknown };
    sessionList?: Record<string, unknown>;
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
  const dismissed = short(raw.dismissed?.to, 64);
  if (dismissed) content.dismissed = { to: dismissed };
  if (typeof raw.forget?.repo === 'string' && isRepoName(raw.forget.repo) && isId(raw.forget.sentAt)) content.forget = { repo: raw.forget.repo, sentAt: raw.forget.sentAt };
  const fingerprint = short(raw.trust?.fingerprint, 64);
  if (isId(raw.trust?.user) && fingerprint && isId(raw.trust.sentAt)) content.trust = { user: raw.trust.user, fingerprint, sentAt: raw.trust.sentAt };
  if (isId(raw.sleep?.sentAt)) content.sleep = { sentAt: raw.sleep.sentAt };
  if (isId(raw.pick?.sentAt)) content.pick = { sentAt: raw.pick.sentAt };
  if (isId(raw.setup?.sentAt)) {
    // A choice of the wrong shape asks only, so it changes nothing.
    const choice = readChoice(raw.setup.choice);
    content.setup = { sentAt: raw.setup.sentAt, ...(choice && { choice }) };
  }
  const state = readSetupState(raw.setupState);
  if (state) content.setupState = state;
  const board = readBoardSync(raw.board);
  if (board) content.board = board;
  const ask = readAsk(raw.ask);
  if (ask) content.ask = ask;
  const note = readCardNote(raw.card);
  if (note) content.card = note;
  const permit = readPermit(raw.permit);
  if (permit) content.permit = permit;
  const file = readFile(raw.file);
  if (file) content.file = file;
  if (typeof raw.sessions?.repo === 'string' && isRepoName(raw.sessions.repo) && isId(raw.sessions.sentAt)) content.sessions = { repo: raw.sessions.repo, sentAt: raw.sessions.sentAt };
  const list = raw.sessionList;
  const [listTo, listHarness] = [short(list?.to, 64), short(list?.harness, LIMITS.harnessFieldLength)];
  if (listTo && listHarness && typeof list!.repo === 'string' && isRepoName(list!.repo)) content.sessionList = { to: listTo, repo: list!.repo, harness: listHarness, sessions: readTerminalSessions(list!.sessions) };
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
// Files (R-005)

/** What encryption adds to a file: its IV in front and the GCM tag. Files are not padded. */
export const FILE_OVERHEAD = 28;

/**
 * Encrypts a file with a random key of its own, which travels only in the sealed `file` field.
 * The key encrypts this one file once, so no header is bound in: another file's ciphertext under
 * this id would not open with it.
 */
export async function encryptFile(plain: Uint8Array<ArrayBuffer>): Promise<{ key: string; data: Uint8Array<ArrayBuffer> }> {
  const raw = randomBytes(32);
  const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { key: toBase64Url(raw), data: concat(iv, new Uint8Array(data)) };
}

/** Decrypts a downloaded file. Throws TamperedMessageError if it was changed or the key is not its own. */
export async function decryptFile(key: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await subtle().importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, cryptoKey, data.subarray(12)));
  } catch {
    throw new TamperedMessageError('file decryption failed');
  }
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
  /** On a card's first revision: `addCard` opened it, so its author owns the card (the board-lanes decision). */
  opened?: true;
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
  if (raw.opened === true) content.opened = true;
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

// ---------------------------------------------------------------------------------------------
// The harnesses an agent asks to link, which ride its pairing

const PICKS_INFO = 'webchat/pair/picks/v1';

/** The key the agent and the owner's page derive from the code, which the server never has. */
const picksKey = async (code: string) =>
  subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8(PICKS_INFO) },
    await subtle().importKey('raw', pairingSecret(code), 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

/** The agent's keys are bound in, so the server cannot lay a blob of another pairing's under this one. */
const picksAad = (agent: PublicKeysDTO) => concat(utf8(PICKS_INFO), fromBase64Url(agent.dh), fromBase64Url(agent.sign));

/** Seals the picks under the pairing code, padded as content is, so the server sees only a size band. */
export async function sealPicks(code: string, agent: PublicKeysDTO, picks: PairingPick[]): Promise<string> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: picksAad(agent) }, await picksKey(code), padContent(utf8(JSON.stringify(picks))));
  return toBase64Url(concat(iv, new Uint8Array(data)));
}

/** Opens sealed picks, or returns nothing when they do not open or have the wrong shape: the owner still approves as before. */
export async function openPicks(code: string, agent: PublicKeysDTO, sealed: string): Promise<PairingPick[]> {
  try {
    const bytes = fromBase64Url(sealed);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: picksAad(agent) }, await picksKey(code), bytes.subarray(12));
    const list = JSON.parse(decoder.decode(unpadContent(new Uint8Array(plain)))) as Array<Record<string, unknown> | null>;
    return list.slice(0, LIMITS.harnesses).flatMap((p) => {
      const name = short(p?.name, LIMITS.harnessFieldLength);
      const version = short(p?.version, 64);
      return name ? [{ name, ...(version && { version }), ...(typeof p?.signedIn === 'boolean' && { signedIn: p.signedIn }) }] : [];
    });
  } catch {
    return [];
  }
}
