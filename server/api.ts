import { waitUntil } from '@vercel/functions';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  DEVICE_COOKIE,
  dummyPasswordHash,
  hashPassword,
  hashToken,
  newSessionToken,
  parseCookies,
  safeEqual,
  SESSION_COOKIE,
  verifyPassword,
} from './auth.js';
import { newCipherKey, newDeviceKey, newLinkToken, type Bark } from './bark.js';
import type { Config } from './config.js';
import {
  keyBackupOf,
  toUserDTO,
  type Db,
  type LeaveRefusal,
  type ProjectChangeRefusal,
  type SharedChannelKey,
  type UserRow,
} from './db.js';
import { GithubError, type Github } from './github.js';
import type { GithubApp } from './githubApp.js';
import { notifyAddedToGroup, notifyAddedToProject, notifyNewMessage, ringUrgent } from './notify.js';
import type { Push, PushSubscriptionInput } from './push.js';
import {
  isChannelName,
  isRepoName,
  LIMITS,
  type AccountKeysInput,
  type BarkDTO,
  type BootstrapDTO,
  type ChatKeyInput,
  type ConfigDTO,
  type CreateDocInput,
  type CreateProjectResponse,
  type EnvelopeDTO,
  type FirstChatKeyInput,
  type GithubDTO,
  type LoginResponse,
  type KeyLinkInput,
  type MessageDTO,
  type MessageKind,
  type PairingInput,
  type ProjectReposDTO,
  type PushPayload,
  type RotatedChannelKeyInput,
  type RotatedKeyInput,
  type SyncRequest,
  type SyncResponse,
} from '../shared/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: UserRow;
      sessionHash?: string;
    }
  }
}

class HttpError extends Error {
  status: number;
  /** Machine-readable reason the client acts on, such as "upgrade_required". */
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const USERNAME = /^[a-z0-9_.]{3,24}$/i;

/** Holds the OAuth state while the user signs in on GitHub. Only the GitHub routes ever see it. */
const GITHUB_STATE_COOKIE = 'webchat_github';
/** Holds the project, and the GitHub App sign-in's state, while a project's owner links a repository on GitHub. */
const GITHUB_APP_COOKIE = 'webchat_github_app';

function text(value: unknown, field: string, min: number, max: number): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max) {
    throw new HttpError(400, `${field} must be ${min}-${max} characters.`);
  }
  return result;
}

const MAX_ID = 2_147_483_647; // Postgres INTEGER

function positiveInt(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0 || result > MAX_ID) throw new HttpError(400, `${field} is invalid.`);
  return result;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Checks a base64url field's length. Exact lengths follow from the key and IV sizes in shared/e2ee.ts. */
function base64url(value: unknown, field: string, min: number, max = min): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || !BASE64URL.test(value)) {
    throw new HttpError(400, `${field} is invalid.`);
  }
  return value;
}

/** 32-byte login key the browser derives from the password. */
const loginKey = (body: unknown) => base64url((body as { authKey?: unknown } | undefined)?.authKey, 'Login key', 43);

function accountKeys(value: unknown): AccountKeysInput {
  const keys = value as Partial<AccountKeysInput> | undefined;
  return {
    // Raw P-256 public keys are 65 bytes.
    dh: base64url(keys?.dh, 'Encryption key', 87),
    sign: base64url(keys?.sign, 'Signing key', 87),
    backup: {
      iv: base64url(keys?.backup?.iv, 'Key backup', 16),
      data: base64url(keys?.backup?.data, 'Key backup', 100, 2000),
    },
  };
}

/** A chat key with its copies, each for a different person. Says nothing yet about who they must be. */
function wrappedChatKey(value: unknown): ChatKeyInput {
  const key = value as Partial<ChatKeyInput> | undefined;
  const list: unknown[] = Array.isArray(key?.wrappedKeys) ? key.wrappedKeys : [];
  const wrappedKeys = list.map((item) => {
    const k = item as { userId?: unknown; iv?: unknown; data?: unknown } | undefined;
    // A wrapped 32-byte key plus its 16-byte tag.
    return { userId: positiveInt(k?.userId, 'userId'), iv: base64url(k?.iv, 'Wrapped key', 16), data: base64url(k?.data, 'Wrapped key', 64) };
  });
  if (new Set(wrappedKeys.map((k) => k.userId)).size !== wrappedKeys.length) {
    throw new HttpError(400, 'The chat key must be wrapped once for every member.');
  }
  return { keyId: base64url(key?.keyId, 'Chat key id', 22), wrappedKeys };
}

/** A new key to replace a chat's current one, with the current key encrypted inside it. */
function rotatedKey(value: unknown): RotatedKeyInput {
  const link = (value as { link?: Partial<KeyLinkInput> } | undefined)?.link;
  return {
    ...wrappedChatKey(value),
    link: {
      previousKeyId: base64url(link?.previousKeyId, 'Chat key id', 22),
      // The previous 32-byte key plus its 16-byte tag.
      iv: base64url(link?.iv, 'Key link', 16),
      data: base64url(link?.data, 'Key link', 64),
    },
  };
}

/** A chat key must come wrapped exactly once for each member. */
function chatKey(value: unknown, memberIds: number[]): ChatKeyInput {
  const key = wrappedChatKey(value);
  const ids = new Set(key.wrappedKeys.map((k) => k.userId));
  if (ids.size !== memberIds.length || memberIds.some((id) => !ids.has(id))) {
    throw new HttpError(400, 'The chat key must be wrapped once for every member.');
  }
  return key;
}

/** A list of distinct user ids, without the given one. */
function userIds(value: unknown, field: string, without: number): number[] {
  const raw: unknown[] = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((v) => positiveInt(v, field)))].filter((id) => id !== without);
}

function channelName(value: unknown): string {
  const name = text(value, 'Channel name', 1, LIMITS.channelNameLength);
  if (!isChannelName(name)) throw new HttpError(400, 'Channel names use lowercase letters, numbers and single hyphens.');
  return name;
}

/** GitHub's ids outgrow a Postgres INTEGER, so they get their own check. */
function githubId(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new HttpError(400, `${field} is invalid.`);
  return result;
}

/** Turns a refused project change into the error the client acts on. */
function projectRefusal(refusal: ProjectChangeRefusal): HttpError {
  if (refusal === 'name_taken') return new HttpError(409, 'This project already has a channel with that name.', 'name_taken');
  if (refusal === 'already_member') return new HttpError(409, 'Someone you picked is already in this project.', 'already_member');
  if (refusal === 'owner') return new HttpError(409, 'Make someone else the owner before you leave.', 'owner');
  return new HttpError(409, 'The project changed while you were editing. Try again.', 'stale_project');
}

function leaveRefusal(refusal: LeaveRefusal): HttpError {
  if (refusal === 'owner') return new HttpError(409, 'Make someone else the owner before you leave.', 'owner');
  if (refusal === 'last_member') return new HttpError(409, 'You are the last member. Delete the group instead.', 'last_member');
  return new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
}

function rotatedChannelKeys(value: unknown): RotatedChannelKeyInput[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.map((item) => {
    const k = item as { conversationId?: unknown } | undefined;
    return { conversationId: positiveInt(k?.conversationId, 'conversationId'), ...rotatedKey(item) };
  });
}

function envelope(value: unknown, maxLength: number = LIMITS.ciphertextLength): EnvelopeDTO {
  const e = value as Partial<EnvelopeDTO> | undefined;
  if (e?.v !== 1) throw new HttpError(400, 'Messages must be encrypted.');
  return {
    v: 1,
    kid: base64url(e.kid, 'Chat key id', 22),
    iv: base64url(e.iv, 'Message', 16),
    ct: base64url(e.ct, 'Message', 22, maxLength),
    // A P-256 signature is 64 bytes.
    sig: base64url(e.sig, 'Signature', 86),
  };
}

/** A doc's id is a chat key id's size: 16 random bytes. */
/**
 * The repositories a check-in names: every one an agent's laptop has a folder for (R-036), or the
 * one an older plugin's session is open in. Names only, never a path.
 */
function checkedInRepos({ repos, repo }: Partial<SyncRequest>) {
  const named = Array.isArray(repos) ? repos.slice(0, LIMITS.agentRepos) : [repo];
  return [...new Set(named.filter((r): r is string => typeof r === 'string' && isRepoName(r)))];
}

const docId = (value: unknown) => base64url(value, 'Doc id', 22);

/** "title", or the 8 random bytes a browser names a section with. */
const docSection = (value: unknown) => (value === 'title' ? value : base64url(value, 'Section', 11));

function currentUser(res: Response): UserRow {
  const user = res.locals.user;
  if (!user) throw new HttpError(401, 'Sign in first.');
  return user;
}

/**
 * The query string, read with the WHATWG URL API. Reading req.query makes Express call Node's
 * url.parse(), which logs a deprecation warning (DEP0169) on Vercel.
 */
const queryOf = (req: Request) => new URL(req.originalUrl, 'http://localhost').searchParams;

/**
 * Keeps a serverless function alive until background work (like sending pushes) finishes. Off
 * Vercel, waitUntil ignores the promise, so an unhandled failure here would stop the Node process.
 */
function inBackground(work: Promise<unknown>, logger: Config['logger']) {
  waitUntil(work.catch((error: unknown) => logger.error('Background work failed', error)));
}

interface ApiDeps {
  db: Db;
  push: Push;
  bark: Bark;
  github: Github;
  githubApp: GithubApp;
  config: Config;
  inviteCode: string;
  kdfSalt: string;
}

export function createApiRouter({ db, push, bark, github, githubApp, config, inviteCode, kdfSalt }: ApiDeps) {
  const router = express.Router();

  function startSession(req: Request, res: Response, user: UserRow) {
    const { token, tokenHash } = newSessionToken();
    const maxAge = config.sessionDays * 24 * 3600_000;
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
    markDevice(req, res);
    return db.createSession(tokenHash, user.id, Date.now() + maxAge);
  }

  /**
   * The cookie holds no id, so the server learns nothing about the device. It lasts 400 days, the
   * most browsers keep a cookie, and every sign-in starts that again.
   */
  function markDevice(req: Request, res: Response) {
    const maxAge = 400 * 24 * 3600_000;
    res.cookie(DEVICE_COOKIE, '1', { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
  }

  const authLimitKey = (req: Request) => `auth:${req.ip ?? 'unknown'}`;

  /**
   * Every attempt counts before it runs, so parallel guesses cannot all pass the check. A route
   * gives the hit back once the attempt succeeds, so only failures use up the limit (D-068).
   */
  async function limitAuth(req: Request, _res: Response, next: NextFunction) {
    if (!(await db.takeRateLimit(authLimitKey(req), 20, 15 * 60_000))) {
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
    next();
  }

  async function sessionOf(req: Request) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const sessionHash = token ? hashToken(token) : undefined;
    const user = sessionHash ? await db.sessionUser(sessionHash) : undefined;
    return { user, sessionHash };
  }

  async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const { user, sessionHash } = await sessionOf(req);
    if (!user) throw new HttpError(401, 'Sign in first.');
    // All tabs of a browser share one session cookie. A tab still showing an account that another
    // tab signed out of names its account here, so it is stopped instead of acting as the new one.
    const expected = req.get('x-webchat-user');
    if (expected !== undefined && Number(expected) !== user.id) {
      throw new HttpError(409, 'This browser signed in to another account in a different tab.', 'account_changed');
    }
    res.locals.user = user;
    res.locals.sessionHash = sessionHash;
    next();
  }

  async function requireMember(conversationId: number, userId: number) {
    if (!(await db.isMember(conversationId, userId))) throw new HttpError(404, 'Chat not found.');
  }

  async function requireProjectMember(projectId: number, userId: number) {
    if (!(await db.isProjectMember(projectId, userId))) throw new HttpError(404, 'Project not found.');
  }

  /** Only a project's owner can remove people from it, delete it or its channels, or hand it over. */
  async function requireProjectOwner(projectId: number, userId: number) {
    await requireProjectMember(projectId, userId);
    if ((await db.getProject(projectId))?.created_by !== userId) {
      throw new HttpError(403, 'Only the owner of this project can do that.', 'not_owner');
    }
  }

  /** The same for a group. A group without an owner (see ConversationDTO.ownerId) is up to any member. */
  async function requireGroupOwner(conversationId: number, userId: number) {
    await requireMember(conversationId, userId);
    const chat = await db.getConversation(conversationId);
    if (chat?.type !== 'group') throw new HttpError(400, 'Only a group can be deleted or have people removed.');
    if (chat.created_by !== null && chat.created_by !== userId) {
      throw new HttpError(403, 'Only the owner of this group can do that.', 'not_owner');
    }
  }

  /**
   * Whom a project or group is handed to: a person, never an agent, which can neither remove people
   * nor hand it back (D-114). No account becomes an agent later, so this needs no lock.
   */
  async function newOwnerOf(body: { userId?: unknown } | undefined) {
    const userId = positiveInt(body?.userId, 'userId');
    if ((await db.getUser(userId))?.agent_owner) throw new HttpError(400, 'An agent cannot own a project or group.', 'agent_owner');
    return userId;
  }

  /** True when the user owns the project. For page loads, which answer with redirects instead of errors. */
  const ownsProject = async (projectId: number, userId: number) =>
    Number.isInteger(projectId) &&
    projectId > 0 &&
    projectId <= MAX_ID &&
    (await db.isProjectMember(projectId, userId)) &&
    (await db.getProject(projectId))?.created_by === userId;

  /** Content is sealed with the chat's current key, never with one that someone who left holds. */
  async function requireCurrentKey(conversationId: number, keyId: string) {
    const chat = await db.conversationKey(conversationId);
    if (!chat.key_id) throw new HttpError(409, 'Set up encryption for this chat first.', 'no_chat_key');
    if (chat.needs_new_key) throw new HttpError(409, 'Someone left this chat, so it needs a new key first.', 'needs_new_key');
    if (keyId !== chat.key_id) throw new HttpError(409, 'This chat uses a different key. Reload and try again.', 'stale_key');
  }

  /** A doc in a chat the user is in. Anyone else learns nothing, not even that it exists. */
  async function requireDoc(id: string, userId: number) {
    const doc = await db.getDoc(id);
    if (!doc || !(await db.isMember(doc.conversation_id, userId))) throw new HttpError(404, 'Doc not found.');
    return doc;
  }

  /** A chat key can only be wrapped for people who have set up encryption. */
  async function requireKeys(userIds: number[]) {
    for (const id of userIds) {
      const user = await db.getUser(id);
      if (!user || user.deleted_at !== null) throw new HttpError(404, 'Person not found.');
      if (!user.dh_public) {
        throw new HttpError(409, `${user.display_name} has not set up encryption yet. They need to sign in again.`, 'no_keys');
      }
    }
  }

  /**
   * A new chat's first key, for an id reserved for this user and not used yet, which its copies
   * name (D-111). Wrapped exactly once for each of `memberIds` when given.
   */
  async function firstKey(value: unknown, userId: number, memberIds?: number[]): Promise<FirstChatKeyInput> {
    const key = memberIds ? chatKey(value, memberIds) : wrappedChatKey(value);
    const conversationId = positiveInt((value as { conversationId?: unknown } | undefined)?.conversationId, 'Chat id');
    if (!(await db.takeConversationId(conversationId, userId))) throw new HttpError(400, 'That chat id was not reserved for you.');
    return { ...key, conversationId };
  }

  /** Marks the newest message from others in each chat as delivered to this user. */
  function markDeliveredFrom(userId: number, messages: MessageDTO[]) {
    const upTo = new Map<number, number>();
    for (const m of messages) {
      if (m.senderId !== userId) upTo.set(m.conversationId, Math.max(upTo.get(m.conversationId) ?? 0, m.id));
    }
    return upTo.size > 0 ? db.markDelivered(userId, upTo) : Promise.resolve();
  }

  router.get('/config', (_req, res) => {
    const body: ConfigDTO = { vapidPublicKey: push.publicKey, kdfSalt };
    res.json(body);
  });

  router.post('/auth/register', limitAuth, async (req, res) => {
    if (parseCookies(req.headers.cookie)[DEVICE_COOKIE]) {
      throw new HttpError(403, 'This device already has a WebChat account. Sign in to it instead.');
    }
    const username = text(req.body?.username, 'Username', 3, 24);
    if (!USERNAME.test(username)) throw new HttpError(400, 'Username can use letters, numbers, dots and underscores.');
    const displayName = text(req.body?.displayName, 'Name', 1, LIMITS.displayNameLength);
    const authKey = loginKey(req.body);
    const keys = accountKeys(req.body?.keys);
    if (!safeEqual(String(req.body?.inviteCode ?? '').trim(), inviteCode)) {
      throw new HttpError(403, 'Invite code is wrong. Ask the owner for it.');
    }
    const user = await db.createUser(username, displayName, await hashPassword(authKey), keys);
    if (!user) throw new HttpError(409, 'That username is taken.');
    await db.returnRateLimit(authLimitKey(req));
    await startSession(req, res, user);
    res.status(201).json(toUserDTO(user));
  });

  router.post('/auth/login', limitAuth, async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const authKey = typeof req.body?.authKey === 'string' ? req.body.authKey : '';
    const user = await db.findUserByUsername(username);
    if (user?.auth_version === 1) {
      throw new HttpError(409, 'This account needs a one-time upgrade for encryption.', 'upgrade_required');
    }
    // Check a dummy hash for unknown users too, so response time does not reveal which usernames exist.
    const valid = await verifyPassword(authKey, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !valid) throw new HttpError(401, 'Wrong username or password.');
    await db.returnRateLimit(authLimitKey(req));
    await startSession(req, res, user);
    inBackground(db.purgeExpired(), config.logger);
    const body: LoginResponse = { user: toUserDTO(user), backup: keyBackupOf(user) };
    res.json(body);
  });

  /**
   * One-time switch for accounts from before encryption: checks the old password, then stores the
   * hash of the new login key instead. This is the only request that ever carries a password.
   */
  router.post('/auth/upgrade', limitAuth, async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const authKey = loginKey(req.body);
    const user = await db.findUserByUsername(username);
    const valid = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || user.auth_version !== 1 || !valid) throw new HttpError(401, 'Wrong username or password.');
    const upgraded = await db.upgradeAuth(user.id, await hashPassword(authKey));
    if (!upgraded) throw new HttpError(409, 'This account was already upgraded. Sign in again.');
    await db.returnRateLimit(authLimitKey(req));
    await startSession(req, res, upgraded);
    const body: LoginResponse = { user: toUserDTO(upgraded), backup: null };
    res.json(body);
  });

  /** Returns the sealed private keys. Needs the login key, so a stolen session cookie alone is not enough. */
  router.post('/keys/backup', limitAuth, requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (me.auth_version === 1) {
      throw new HttpError(409, 'This account needs a one-time upgrade for encryption.', 'upgrade_required');
    }
    if (!(await verifyPassword(loginKey(req.body), me.password_hash))) throw new HttpError(403, 'Wrong password.');
    await db.returnRateLimit(authLimitKey(req));
    const body: LoginResponse = { user: toUserDTO(me), backup: keyBackupOf(me) };
    res.json(body);
  });

  /** Stores an account's keys, once. Later changes would let anyone with the login key replace them. */
  router.put('/keys', limitAuth, requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (me.auth_version === 1) {
      throw new HttpError(409, 'This account needs a one-time upgrade for encryption.', 'upgrade_required');
    }
    if (!(await verifyPassword(loginKey(req.body), me.password_hash))) throw new HttpError(403, 'Wrong password.');
    const updated = await db.setUserKeys(me.id, accountKeys(req.body?.keys));
    if (!updated) throw new HttpError(409, 'This account already has keys.');
    await db.returnRateLimit(authLimitKey(req));
    res.json(toUserDTO(updated));
  });

  router.post('/auth/logout', requireAuth, async (req, res) => {
    await db.deleteSession(res.locals.sessionHash!);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    // A browser signed in from before D-080 has no device cookie yet.
    markDevice(req, res);
    res.status(204).end();
  });

  /** Deletes the account (R-028, D-088). Owned projects and groups with other people in them block it. */
  router.delete('/auth/account', requireAuth, async (_req, res) => {
    if (!(await db.deleteUser(currentUser(res).id))) {
      throw new HttpError(409, 'Hand over or delete the projects and groups you own first.', 'owner');
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    // The device has no account any more, so it may sign up for one again (D-080).
    res.clearCookie(DEVICE_COOKIE, { path: '/' });
    res.status(204).end();
  });

  /**
   * A coding agent's half of a pairing (R-030, D-093), sent before it has an account. Its owner
   * approves it from their page within 10 minutes. The login key is kept hashed, as a password is.
   */
  router.post('/pairings', async (req, res) => {
    if (!(await db.takeRateLimit(`pair:${req.ip ?? 'unknown'}`, 10, 15 * 60_000))) {
      throw new HttpError(429, 'Too many pairings. Try again in 15 minutes.');
    }
    const body = req.body as Partial<PairingInput> | undefined;
    const input: PairingInput = {
      id: base64url(body?.id, 'Pairing id', 43),
      keys: { dh: base64url(body?.keys?.dh, 'Encryption key', 87), sign: base64url(body?.keys?.sign, 'Signing key', 87) },
      proof: base64url(body?.proof, 'Pairing proof', 43),
      authKey: loginKey(body),
    };
    if (!(await db.createPairing(input, await hashPassword(input.authKey)))) {
      throw new HttpError(409, 'This pairing code was used already. Make a new one in WebChat.');
    }
    res.status(204).end();
  });

  /**
   * A pairing, for the owner's page and for the agent, found by a hash of the code. It holds only
   * public keys and proofs, so it needs no sign-in. None yet, or none any more, answers 204: the
   * page asks every 2 seconds until the agent sends its half.
   */
  router.get('/pairings/:id', async (req, res) => {
    const pairing = await db.pairing(String(req.params.id));
    if (!pairing) return res.status(204).end();
    res.json(pairing);
  });

  /** The owner approves a pairing their page checked: the agent gets an account of its own, theirs. */
  router.post('/pairings/:id/approve', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (me.agent_owner !== null) throw new HttpError(403, 'An agent cannot pair another agent.');
    const displayName = text(req.body?.displayName, 'Name', 1, LIMITS.displayNameLength);
    const agent = await db.approvePairing(String(req.params.id), me.id, displayName, base64url(req.body?.proof, 'Pairing proof', 43));
    if (!agent) throw new HttpError(404, 'This pairing code lapsed or was approved already.');
    res.status(201).json(toUserDTO(agent));
  });

  /** The owner removes one of their agents for good, such as the one left after pairing again (R-033). */
  router.delete('/agents/:id', requireAuth, async (req, res) => {
    if (!(await db.removeAgent(currentUser(res).id, positiveInt(req.params.id, 'Agent')))) throw new HttpError(404, 'Agent not found.');
    res.status(204).end();
  });

  router.get('/bootstrap', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    // The fingerprint first: a change that lands while the rest loads then makes the first
    // check-in answer "changed" instead of being counted as seen without being sent.
    const stamp = await db.stamp(me.id);
    const [users, projects, conversations, cursor, urgent, docs] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      db.latestMessageId(me.id),
      db.unreadUrgent(me.id),
      db.docsFor(me.id),
    ]);
    const now = Date.now();
    const body: BootstrapDTO = {
      me: toUserDTO(me, now),
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      cursor,
      stamp,
      urgent,
      docs,
    };
    res.json(body);
  });

  /**
   * The client's check-in. It reports whether the user is looking at the app and gets back what
   * changed. A cheap fingerprint check answers most calls without loading anything else.
   */
  router.post('/sync', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const input = (req.body ?? {}) as Partial<SyncRequest>;
    const cursor = Number.isInteger(input.cursor) && input.cursor! >= 0 ? Math.min(input.cursor!, MAX_ID) : 0;
    const tabId = typeof input.tabId === 'string' ? input.tabId.slice(0, 64) : '';
    const endpoint = typeof input.endpoint === 'string' && input.endpoint.length <= 1000 ? input.endpoint : null;

    const editing = input.editing;
    await Promise.all([
      db.checkIn(me.id, input.attentive === true, tabId, endpoint, checkedInRepos(input), Number.isInteger(input.protocol) && input.protocol! > 0 && input.protocol! < 100 ? input.protocol : 0, Array.isArray(input.repos)),
      typeof editing?.docId === 'string' && typeof editing.section === 'string'
        ? db.renewSectionLock(me.id, editing.docId.slice(0, 64), editing.section.slice(0, 64))
        : undefined,
    ]);
    const stamp = await db.stamp(me.id);
    if (stamp === input.stamp) {
      const body: SyncResponse = { changed: false, stamp, cursor };
      return res.json(body);
    }

    const messages = await db.messagesSince(me.id, cursor);
    await markDeliveredFrom(me.id, messages);
    const [users, projects, conversations, docs, newStamp] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      db.docsFor(me.id),
      // Marking messages delivered changes the fingerprint, so read it again.
      db.stamp(me.id),
    ]);
    const newCursor = messages.reduce((max, m) => Math.max(max, m.id), cursor);
    // Each read above sees its own moment. A message that committed after messagesSince, or past
    // its page limit, is already counted in newStamp. Returning that stamp would make every later
    // check-in answer "unchanged" without the message, so send no stamp and ask for another round.
    const more = (await db.latestMessageId(me.id)) > newCursor;
    const now = Date.now();
    const body: SyncResponse = {
      changed: true,
      stamp: more ? '' : newStamp,
      more,
      cursor: newCursor,
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      messages,
      docs,
    };
    res.json(body);
  });

  /** Sent with navigator.sendBeacon when a tab closes, so pushes go to the phone right away. */
  router.post('/away', requireAuth, async (req, res) => {
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId.slice(0, 64) : '';
    await db.checkIn(currentUser(res).id, false, tabId, null);
    res.status(204).end();
  });

  /** Reserves the id of a chat this user is about to create, for the copies of its first key to name (D-111). */
  router.post('/conversations/ids', requireAuth, async (_req, res) => {
    res.json({ id: await db.reserveConversationId(currentUser(res).id) });
  });

  router.post('/conversations/direct', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const otherId = positiveInt(req.body?.userId, 'userId');
    if (otherId === me.id || !(await db.getUser(otherId))) throw new HttpError(404, 'Person not found.');
    let id = await db.findDirect(me.id, otherId);
    if (id === undefined) {
      const memberIds = [me.id, otherId];
      await requireKeys(memberIds);
      const key = await firstKey(req.body?.key, me.id, memberIds);
      id = await db.createConversation('direct', null, memberIds, { ...key, wrappedBy: me.id });
    }
    res.json(await db.conversationFor(me.id, id));
  });

  router.post('/conversations/group', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const title = text(req.body?.title, 'Group name', 1, LIMITS.groupTitleLength);
    const memberIds = userIds(req.body?.memberIds, 'memberIds', me.id);
    if (memberIds.length === 0) throw new HttpError(400, 'Pick at least one person.');
    const allIds = [me.id, ...memberIds];
    await requireKeys(allIds);
    const key = await firstKey(req.body?.key, me.id, allIds);
    const id = await db.createConversation('group', title, allIds, { ...key, wrappedBy: me.id });
    res.status(201).json(await db.conversationFor(me.id, id));
  });

  /** Deletes a group for everyone, with its messages. */
  router.delete('/conversations/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireGroupOwner(conversationId, me.id);
    await db.deleteConversation(conversationId);
    res.status(204).end();
  });

  /** Adds people to a group. The member adding them shares its key, so they can read the history. */
  router.post('/conversations/:id/members', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'group') throw new HttpError(400, 'Only a group can take new people.');
    const added = userIds(req.body?.userIds, 'userIds', me.id);
    if (added.length === 0) throw new HttpError(400, 'Pick at least one person.');
    if (added.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    await requireKeys(added);
    // Whether the group has a key, and so whether one must come, is checked while the group is locked.
    const key = req.body?.key == null ? null : chatKey(req.body.key, added);
    const result = await db.addGroupMembers(conversationId, me.id, added, key);
    if (result === 'already_member') throw new HttpError(409, 'Someone you picked is already in this group.', 'already_member');
    if (result !== true) throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    const group = (await db.conversationFor(me.id, conversationId))!;
    inBackground(notifyAddedToGroup(push, config, group, me, added), config.logger);
    res.json(group);
  });

  /**
   * Removes someone from a group. The owner's browser sends a new key for the people who stay, so
   * the person removed cannot read what is sent next.
   */
  router.delete('/conversations/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireGroupOwner(conversationId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    // Whether the key covers exactly the people who stay is checked while the group is locked.
    const key = req.body?.key == null ? null : rotatedKey(req.body.key);
    if (!(await db.removeGroupMember(conversationId, me.id, userId, key))) {
      throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });

  /**
   * Leaves a group. The person leaving cannot make a new key for the others, so a member who stays
   * replaces it (PUT /conversations/:id/key) before anyone sends again.
   */
  router.post('/conversations/:id/leave', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'group') throw new HttpError(400, 'Only a group can be left.');
    const result = await db.leaveGroup(conversationId, me.id);
    if (result !== true) throw leaveRefusal(result);
    res.status(204).end();
  });

  /** Hands a group to another member. Its owner does this before leaving. */
  router.put('/conversations/:id/owner', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireGroupOwner(conversationId, me.id);
    if (!(await db.handOverGroup(conversationId, me.id, await newOwnerOf(req.body)))) {
      throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });

  /**
   * Replaces a chat's key: after someone left, or when a page finds its copy is from before copies
   * named their chat (K-65). Any member can, and the first one wins.
   */
  router.put('/conversations/:id/key', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    // Whether the key covers exactly the members is checked while the chat is locked.
    if (!(await db.replaceConversationKey(conversationId, me.id, rotatedKey(req.body)))) {
      throw new HttpError(409, 'This chat has a new key already. Reload and try again.', 'stale_key');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });

  /** Creates a project with its #general channel. Starting alone is fine; members can add people later. */
  router.post('/projects', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const name = text(req.body?.name, 'Project name', 1, LIMITS.projectNameLength);
    const memberIds = userIds(req.body?.memberIds, 'memberIds', me.id);
    if (memberIds.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    const allIds = [me.id, ...memberIds];
    await requireKeys(allIds);
    const key = await firstKey(req.body?.key, me.id, allIds);
    const { projectId, channelId } = await db.createProject(name, me.id, allIds, key);
    const project = (await db.projectFor(me.id, projectId))!;
    if (memberIds.length > 0) inBackground(notifyAddedToProject(push, config, project, channelId, me, memberIds), config.logger);
    const body: CreateProjectResponse = { project, channel: (await db.conversationFor(me.id, channelId))! };
    res.status(201).json(body);
  });

  router.post('/projects/:id/channels', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const name = channelName(req.body?.name);
    // Whether the key covers exactly the project's members is checked while the project is locked.
    const key = await firstKey(req.body?.key, me.id);
    const created = await db.createChannel(projectId, name, me.id, key);
    if (typeof created !== 'number') throw projectRefusal(created);
    res.status(201).json(await db.conversationFor(me.id, created));
  });

  /** Deletes a channel for everyone, with its messages. Only the owner can, and never #general (R-034). */
  router.delete('/projects/:id/channels/:channelId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    const conversationId = positiveInt(req.params.channelId, 'Channel id');
    await requireProjectOwner(projectId, me.id);
    const result = await db.deleteChannel(projectId, conversationId);
    if (result === 'not_found') throw new HttpError(404, 'Channel not found.');
    if (result === 'general') throw new HttpError(400, 'A project keeps its #general channel. Delete the project instead.');
    res.status(204).end();
  });

  /** Adds people to a project. The member adding them shares every channel key, so they can read the history. */
  router.post('/projects/:id/members', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const added = userIds(req.body?.userIds, 'userIds', me.id);
    if (added.length === 0) throw new HttpError(400, 'Pick at least one person.');
    if (added.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    await requireKeys(added);
    const list: unknown[] = Array.isArray(req.body?.channelKeys) ? req.body.channelKeys : [];
    const channelKeys: SharedChannelKey[] = list.map((item) => {
      const k = item as { conversationId?: unknown } | undefined;
      return { conversationId: positiveInt(k?.conversationId, 'conversationId'), ...chatKey(item, added) };
    });
    const result = await db.addProjectMembers(projectId, me.id, added, channelKeys);
    if (result !== true) throw projectRefusal(result);
    // The adder can be removed again the moment the change commits.
    const project = await db.projectFor(me.id, projectId);
    if (!project) throw new HttpError(403, 'You are no longer in this project.', 'not_member');
    // #general is the project's first channel.
    const general = channelKeys.length > 0 ? Math.min(...channelKeys.map((k) => k.conversationId)) : null;
    inBackground(notifyAddedToProject(push, config, project, general, me, added), config.logger);
    res.json(project);
  });

  /**
   * Removes someone from a project and every channel in it. The owner's browser sends a new key for
   * each channel, wrapped for the people who stay, so the person removed cannot read what comes next.
   */
  router.delete('/projects/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireProjectOwner(projectId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    // Whether the keys cover exactly the people who stay is checked while the project is locked.
    const result = await db.removeProjectMember(projectId, me.id, userId, rotatedChannelKeys(req.body?.channelKeys));
    if (result !== true) throw projectRefusal(result);
    res.json(await db.projectFor(me.id, projectId));
  });

  /** The repositories a project links, and for its owner, the ones they can link now. */
  async function reposView(projectId: number, userId: number): Promise<ProjectReposDTO> {
    const owner = (await db.getProject(projectId))?.created_by === userId;
    return {
      configured: githubApp.configured,
      repos: await db.projectRepos(projectId),
      choices: owner && githubApp.configured ? await db.githubChoices(userId, projectId) : [],
    };
  }

  /** Every member sees the links; only the owner changes them. */
  router.get('/projects/:id/repos', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    res.json(await reposView(projectId, me.id));
  });

  /**
   * Links a repository to a project, or moves its link to another channel. Only a repository the
   * owner just showed GitHub they reach through the GitHub App, so nobody links one they cannot
   * see. Its pull requests then come in as cards from GitHub's webhook (D-050).
   */
  router.post('/projects/:id/repos', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    const grant = await db.githubGrant(me.id, githubId(req.body?.repoId, 'repoId'));
    if (!grant) {
      throw new HttpError(409, 'Choose the repository on GitHub again, then link it within half an hour.', 'no_grant');
    }
    const result = await db.linkProjectRepo(projectId, grant, positiveInt(req.body?.conversationId, 'conversationId'), me.id);
    if (result === 'no_channel') throw new HttpError(400, 'Pick a channel of this project.');
    if (result === 'too_many') {
      throw new HttpError(409, `A project links at most ${LIMITS.reposPerProject} repositories.`, 'too_many_repos');
    }
    res.json(await reposView(projectId, me.id));
  });

  router.delete('/projects/:id/repos/:repoId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    await db.unlinkProjectRepo(projectId, githubId(req.params.repoId, 'repoId'));
    res.json(await reposView(projectId, me.id));
  });

  /**
   * Leaves a project. The person leaving cannot make new keys for the others, so a member who stays
   * replaces each channel's key (PUT /conversations/:id/key) before anyone sends there again.
   */
  router.post('/projects/:id/leave', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const result = await db.leaveProject(projectId, me.id);
    if (result !== true) throw projectRefusal(result);
    res.status(204).end();
  });

  /** Hands a project to another member. Its owner does this before leaving. */
  router.put('/projects/:id/owner', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    if (!(await db.handOverProject(projectId, me.id, await newOwnerOf(req.body)))) {
      throw projectRefusal('stale');
    }
    res.json(await db.projectFor(me.id, projectId));
  });

  /** Deletes a project for everyone, with its channels and their messages. */
  router.delete('/projects/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    await db.deleteProject(projectId);
    res.status(204).end();
  });

  /** A new doc in a project's channel, with its title and first sections (R-020). */
  router.post('/docs', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const input = (req.body ?? {}) as Partial<CreateDocInput>;
    const id = docId(input.id);
    const conversationId = positiveInt(input.conversationId, 'Chat id');
    const raw = Array.isArray(input.revisions) ? input.revisions : [];
    const revisions = raw.map((r) => ({ section: docSection(r?.section), envelope: envelope(r?.envelope, LIMITS.docCiphertextLength) }));
    const sections = new Set(revisions.map((r) => r.section));
    if (!sections.has('title') || sections.size !== revisions.length || revisions.length > LIMITS.docSectionsAtOnce + 1) {
      throw new HttpError(400, `A doc needs a title and at most ${LIMITS.docSectionsAtOnce} sections, each once.`);
    }
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'channel') throw new HttpError(400, 'Docs belong to a project.');
    for (const kid of new Set(revisions.map((r) => r.envelope.kid))) await requireCurrentKey(conversationId, kid);
    if (!(await db.takeRateLimit(`docs:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');
    if (!(await db.createDoc(id, conversationId, me.id, revisions))) throw new HttpError(409, 'A doc with this id exists.');
    res.status(201).json(await db.docFor(me.id, id));
  });

  /** The newest revision of every section of a doc. */
  router.get('/docs/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    res.json(await db.docSections(doc.id));
  });

  /** One person deletes a doc for everyone: whoever made it, or the project's owner. */
  router.delete('/docs/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    if (doc.created_by !== me.id) await requireProjectOwner((await db.getConversation(doc.conversation_id))!.project_id!, me.id);
    await db.deleteDoc(doc.id);
    res.status(204).end();
  });

  /** A section's earlier revisions, newest first. */
  router.get('/docs/:id/sections/:section', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    res.json(await db.sectionHistory(doc.id, docSection(req.params.section)));
  });

  /** Starts editing a section. Only one person edits a section at a time. */
  router.post('/docs/:id/sections/:section/lock', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    const holder = await db.lockSection(doc.id, docSection(req.params.section), me.id);
    if (holder !== me.id) {
      const name = holder ? (await db.getUser(holder))?.display_name : undefined;
      throw new HttpError(409, `${name ?? 'Someone'} is editing this section. Try again when they are done.`, 'locked');
    }
    res.status(204).end();
  });

  router.delete('/docs/:id/sections/:section/lock', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    await db.unlockSection(doc.id, docSection(req.params.section), me.id);
    res.status(204).end();
  });

  /** Saves a section, sealed for the doc's chat, by the person who holds its lock. */
  router.put('/docs/:id/sections/:section', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    const sealed = envelope(req.body?.envelope, LIMITS.docCiphertextLength);
    await requireCurrentKey(doc.conversation_id, sealed.kid);
    if (!(await db.takeRateLimit(`docs:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');
    const revision = await db.saveSection(doc.id, docSection(req.params.section), me.id, sealed);
    if (!revision) throw new HttpError(409, 'Someone else is editing this section now.', 'not_locked');
    res.json(revision);
  });

  /** Sets the key of a chat from before encryption. The first member to send a message does this. */
  router.post('/conversations/:id/key', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    const memberIds = await db.memberIds(conversationId);
    await requireKeys(memberIds);
    const key = chatKey(req.body, memberIds);
    // The members can change before the key is stored, so they are checked again under the lock.
    const result = await db.setConversationKey(conversationId, key.keyId, me.id, key.wrappedKeys);
    if (result === 'has_key') throw new HttpError(409, 'This chat already has a key.', 'has_key');
    if (result === 'stale') throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    res.json(await db.conversationFor(me.id, conversationId));
  });

  router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    // Read with the WHATWG URL API: on Vercel, reading req.query logs Node's url.parse()
    // deprecation warning (DEP0169).
    const beforeParam = new URL(req.originalUrl, 'http://localhost').searchParams.get('before');
    const before = beforeParam === null ? MAX_ID : positiveInt(beforeParam, 'before');
    res.json(await db.messagesBefore(conversationId, before, LIMITS.pageSize));
  });

  router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    // The server only ever receives ciphertext; it checks the shape, not the content.
    const sealed = envelope(req.body?.envelope);
    // Signed into the envelope, so it must stay exactly as the client sent it.
    const clientId = base64url(req.body?.clientId, 'clientId', 1, 64);
    const kind: Exclude<MessageKind, 'github'> = req.body?.kind === 'reaction' ? 'reaction' : 'message';
    if (req.body?.kind !== undefined && req.body.kind !== kind) throw new HttpError(400, 'Unknown message kind.');
    await requireMember(conversationId, me.id);
    await requireCurrentKey(conversationId, sealed.kid);
    if (!(await db.takeRateLimit(`send:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');

    const urgent = req.body?.urgent === true;
    // The urgent flag is signed into the envelope, so it is refused rather than quietly dropped.
    if (urgent && kind === 'reaction') throw new HttpError(400, 'A reaction cannot be urgent.');
    const { message, repeated } = await db.insertMessage(conversationId, me.id, kind, sealed, urgent, clientId);
    // Answer the sender first; pushes go out after, while the function stays alive.
    if (!repeated) inBackground(notifyNewMessage(db, push, config, message, me), config.logger);
    res.status(repeated ? 200 : 201).json(message);
  });

  router.post('/conversations/:id/read', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    await db.markRead(conversationId, me.id, positiveInt(req.body?.messageId, 'messageId'));
    res.status(204).end();
  });

  /** Called by the service worker when a push arrives, so the sender sees "delivered" even with the app closed. */
  router.post('/delivered', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.body?.conversationId, 'conversationId');
    const messageId = positiveInt(req.body?.messageId, 'messageId');
    await requireMember(conversationId, me.id);
    await db.markDelivered(me.id, new Map([[conversationId, messageId]]));
    res.status(204).end();
  });

  router.post('/push/subscribe', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const subscription = req.body as Partial<PushSubscriptionInput> | undefined;
    const endpoint = subscription?.endpoint;
    const { p256dh, auth } = subscription?.keys ?? {};
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
      throw new HttpError(400, 'Subscription is incomplete.');
    }
    if (endpoint.length > 1000 || p256dh.length > 200 || auth.length > 100 || !push.isAllowedEndpoint(endpoint)) {
      throw new HttpError(400, 'This push service is not supported.');
    }
    // The sizes a browser's P-256 public key and auth secret have. web-push throws on others (K-12).
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
      throw new HttpError(400, 'Subscription keys are invalid.');
    }
    if (!(await db.savePushSubscription(me.id, endpoint, p256dh, auth))) {
      throw new HttpError(409, 'Another account holds this push subscription.', 'endpoint_taken');
    }
    res.status(204).end();
  });

  router.post('/push/unsubscribe', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (typeof req.body?.endpoint === 'string') await db.deleteUserPushSubscription(req.body.endpoint, me.id);
    res.status(204).end();
  });

  // Alerts for iPhones without Web Push, through the Bark app (R-018).

  /** The user's Bark setup as the bell dialog shows it. */
  async function barkView(userId: number): Promise<BarkDTO> {
    const link = bark.configured ? await db.barkLinkFor(userId) : undefined;
    if (!link) return { configured: bark.configured, link: null };
    const devices = await db.barkDevicesFor(userId);
    return {
      configured: true,
      link: {
        serverUrl: `${link.origin}/api/bark/${link.token}`,
        cipherKey: link.cipher_key,
        devices: devices.map((d) => ({ key: d.device_key, registeredAt: d.created_at, seenAt: d.seen_at })),
      },
    };
  }

  /**
   * Where the browser reached this server, which the phone has to reach too: the page's Origin
   * header, since a development proxy rewrites the host; else the host the request asked for.
   */
  const requestOrigin = (req: Request) => {
    const origin = req.get('origin');
    return origin && /^https?:\/\/[^/]+$/.test(origin) ? origin : `${req.protocol}://${req.get('host')}`;
  };

  router.get('/bark', requireAuth, async (_req, res) => {
    res.json(await barkView(currentUser(res).id));
  });

  router.post('/bark/link', requireAuth, async (req, res) => {
    if (!bark.configured) throw new HttpError(409, 'This server has no key for Bark yet.', 'bark_off');
    const me = currentUser(res);
    await db.createBarkLink(me.id, newLinkToken(), requestOrigin(req));
    res.json(await barkView(me.id));
  });

  router.delete('/bark/link', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    await db.deleteBarkLink(me.id);
    res.json(await barkView(me.id));
  });

  /** Turning encryption on makes a fresh key; the person types it into Bark. Off sends alerts plain again. */
  router.put('/bark/encryption', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (!(await db.barkLinkFor(me.id))) throw new HttpError(404, 'Link Bark first.');
    await db.setBarkCipherKey(me.id, req.body?.enabled === true ? newCipherKey() : null);
    res.json(await barkView(me.id));
  });

  /**
   * The routes the Bark app itself calls, with the link's URL as its server. The app cannot sign
   * in, so the token in the URL is the credential. They answer in the JSON shape Bark expects.
   */
  async function barkLinkOf(req: Request) {
    if (!(await db.takeRateLimit(`bark:${req.ip ?? 'unknown'}`, 120, 15 * 60_000))) {
      throw new HttpError(429, 'Too many requests. Try again in 15 minutes.');
    }
    const token = req.params.token;
    const link =
      typeof token === 'string' && token.length === 43 && BASE64URL.test(token) ? await db.barkLinkByToken(token) : undefined;
    if (!link || !bark.configured) throw new HttpError(404, 'Unknown server link.');
    return link;
  }

  const barkAnswer = (res: Response, message: string, data?: Record<string, string>) =>
    res.json({ code: 200, message, timestamp: Math.floor(Date.now() / 1000), ...(data ? { data } : {}) });

  router.get('/bark/:token/ping', async (req, res) => {
    await barkLinkOf(req);
    barkAnswer(res, 'pong');
  });

  /** Bark sends its APNs token, and the key it was given before, if any, in the query or the body. */
  async function registerBark(req: Request, res: Response) {
    const link = await barkLinkOf(req);
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (...names: string[]) => {
      for (const name of names) {
        const value = query.get(name) ?? body[name];
        if (typeof value === 'string' && value) return value;
      }
      return '';
    };
    const deviceToken = field('devicetoken', 'device_token').toLowerCase();
    const key = field('key', 'device_key');
    if (!/^[0-9a-f]{32,200}$/.test(deviceToken)) throw new HttpError(400, 'device token is invalid');
    if (key && !(key.length === 22 && BASE64URL.test(key))) throw new HttpError(400, 'device key is invalid');
    const device = await db.registerBarkDevice(link.user_id, deviceToken, key || null, newDeviceKey());
    barkAnswer(res, 'success', { key: device.device_key, device_key: device.device_key, device_token: device.device_token });
  }
  router.get('/bark/:token/register', registerBark);
  router.post('/bark/:token/register', registerBark);

  /** Where GitHub sends the user back. It must match the callback URL registered on the OAuth App. */
  const githubCallbackUrl = (req: Request) =>
    config.githubCallbackUrl ?? `${req.protocol}://${req.get('host')}/api/github/callback`;

  /** The pane's account and pull requests, and whether projects can link repositories here. */
  const githubView = async (userId: number): Promise<GithubDTO> => ({
    ...(await github.view(userId)),
    appConfigured: githubApp.configured,
  });

  /** The linked GitHub account and its pull requests, fetched again first when the last poll is old. */
  router.get('/github', requireAuth, async (req, res) => {
    const me = currentUser(res);
    await github.refresh(me.id, queryOf(req).get('refresh') === '1');
    res.json(await githubView(me.id));
  });

  /**
   * The page navigates here to link GitHub, and GitHub sends the browser back to /github/callback.
   * Both are page loads, not API calls, so they answer with redirects to the app instead of JSON.
   */
  router.get('/github/connect', async (req, res) => {
    const { user } = await sessionOf(req);
    if (!user || !github.configured) return res.redirect(303, '/?github=error');
    if (!(await db.takeRateLimit(`github:${user.id}`, 10, 15 * 60_000))) return res.redirect(303, '/?github=error');
    const { url, cookie } = github.beginConnect(user.id, githubCallbackUrl(req));
    res.cookie(GITHUB_STATE_COOKIE, cookie, {
      httpOnly: true,
      // Lax still sends it when GitHub redirects back, since that is a top-level page load.
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 10 * 60_000,
      path: '/api/github',
    });
    res.redirect(303, url);
  });

  router.get('/github/callback', async (req, res) => {
    const { user } = await sessionOf(req);
    const cookie = parseCookies(req.headers.cookie)[GITHUB_STATE_COOKIE];
    const query = queryOf(req);
    res.clearCookie(GITHUB_STATE_COOKIE, { path: '/api/github' });
    if (!user || !github.configured) return res.redirect(303, '/?github=error');
    const oauthError = query.get('error');
    if (oauthError) return res.redirect(303, `/?github=${oauthError === 'access_denied' ? 'denied' : 'error'}`);
    try {
      await github.completeConnect(
        user.id,
        cookie,
        query.get('state') ?? '',
        query.get('code') ?? '',
        githubCallbackUrl(req),
      );
    } catch (error) {
      if (error instanceof GithubError) config.logger.warn(`GitHub connect failed for user ${user.id}: ${error.message}`);
      else config.logger.error('GitHub connect failed', error);
      return res.redirect(303, '/?github=error');
    }
    res.redirect(303, '/?github=connected');
  });

  router.patch('/github', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const notify = (req.body as { notify?: unknown } | undefined)?.notify;
    if (typeof notify !== 'boolean') throw new HttpError(400, 'notify must be true or false.');
    await github.setNotify(me.id, notify);
    res.json(await githubView(me.id));
  });

  router.delete('/github', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    await github.disconnect(me.id);
    res.json(await githubView(me.id));
  });

  /** Lets in the database's Supabase Cron jobs, with their own secret, and any other scheduler with CRON_SECRET. */
  const requireScheduler = async (req: Request) => {
    const authorization = req.get('authorization') ?? '';
    if (config.cronSecret && safeEqual(authorization, `Bearer ${config.cronSecret}`)) return;
    const secret = await db.jobSecret();
    if (secret === null || !safeEqual(authorization, `Bearer ${secret}`)) {
      throw new HttpError(401, 'Send the CRON_SECRET as a bearer token.');
    }
  };

  /** Polls every connected account that is due, so alerts arrive while every tab is closed. */
  router.get('/github/poll', async (req, res) => {
    await requireScheduler(req);
    res.json({ polled: await github.pollAll() });
  });

  /** Rings every unread urgent message again, so it rings like an alarm while every tab is closed (D-079). */
  router.get('/urgent/ring', async (req, res) => {
    await requireScheduler(req);
    res.json({ rang: await ringUrgent(db, push) });
  });

  /** Where GitHub sends the owner back after signing in to the GitHub App. It must be a callback URL registered on the app. */
  const githubAppCallbackUrl = (req: Request) =>
    config.githubAppCallbackUrl ?? `${req.protocol}://${req.get('host')}/api/github/app/callback`;

  const githubAppCookie = (req: Request) => ({
    httpOnly: true,
    // Lax still sends it when GitHub redirects back, since that is a top-level page load.
    sameSite: 'lax' as const,
    secure: req.secure,
    maxAge: 15 * 60_000,
    path: '/api/github',
  });

  /** Sends the browser back to the project's repositories dialog, and says how linking went. */
  const backToRepos = (res: Response, projectId: number | null, result: 'repos' | 'repos-denied' | 'repos-error') =>
    res.redirect(303, projectId ? `/?github=${result}&project=${projectId}` : `/?github=${result}`);

  /**
   * The repositories dialog navigates here to install the GitHub App on more repositories. GitHub
   * sends the browser to /github/app/setup afterwards. These routes are page loads, not API calls,
   * so they answer with redirects to the app instead of JSON.
   */
  router.get('/github/app/install', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = Number(queryOf(req).get('project'));
    if (!user || !githubApp.configured || !(await ownsProject(projectId, user.id))) return backToRepos(res, null, 'repos-error');
    res.cookie(GITHUB_APP_COOKIE, githubApp.installCookie(user.id, projectId), githubAppCookie(req));
    res.redirect(303, githubApp.installUrl!);
  });

  /** The Setup URL registered on the app. After an install, the owner signs in to the app to list what they installed it on. */
  router.get('/github/app/setup', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = user ? githubApp.projectOf(parseCookies(req.headers.cookie)[GITHUB_APP_COOKIE], user.id) : null;
    if (!projectId) return res.redirect(303, '/');
    res.redirect(303, `/api/github/app/link?project=${projectId}`);
  });

  /** Starts the sign-in to the GitHub App, which shows the server what the owner can link. */
  router.get('/github/app/link', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = Number(queryOf(req).get('project'));
    if (!user || !githubApp.configured || !(await ownsProject(projectId, user.id))) return backToRepos(res, null, 'repos-error');
    if (!(await db.takeRateLimit(`github-app:${user.id}`, 10, 15 * 60_000))) return backToRepos(res, projectId, 'repos-error');
    const { url, cookie } = githubApp.beginLink(user.id, projectId, githubAppCallbackUrl(req));
    res.cookie(GITHUB_APP_COOKIE, cookie, githubAppCookie(req));
    res.redirect(303, url);
  });

  router.get('/github/app/callback', async (req, res) => {
    const { user } = await sessionOf(req);
    const cookie = parseCookies(req.headers.cookie)[GITHUB_APP_COOKIE];
    const query = queryOf(req);
    res.clearCookie(GITHUB_APP_COOKIE, { path: '/api/github' });
    const projectId = user ? githubApp.projectOf(cookie, user.id) : null;
    if (!user || !githubApp.configured || !projectId) return backToRepos(res, null, 'repos-error');
    const oauthError = query.get('error');
    if (oauthError) return backToRepos(res, projectId, oauthError === 'access_denied' ? 'repos-denied' : 'repos-error');
    try {
      await githubApp.completeLink(user.id, cookie, query.get('state') ?? '', query.get('code') ?? '', githubAppCallbackUrl(req));
    } catch (error) {
      if (error instanceof GithubError) config.logger.warn(`GitHub App sign-in failed for user ${user.id}: ${error.message}`);
      else config.logger.error('GitHub App sign-in failed', error);
      return backToRepos(res, projectId, 'repos-error');
    }
    backToRepos(res, projectId, 'repos');
  });

  /**
   * GitHub's webhook for the GitHub App. app.ts hands this route the raw body, which the signature
   * covers. The cards are written before GitHub gets its answer; the pushes go out after.
   */
  router.post('/github/webhook', async (req, res) => {
    if (!githubApp.configured) throw new HttpError(404, 'Not found.');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const cards = await githubApp.receive(
      { signature: req.get('x-hub-signature-256'), event: req.get('x-github-event'), delivery: req.get('x-github-delivery') },
      body,
    );
    if (!cards) throw new HttpError(401, 'The signature does not match.');
    for (const card of cards) inBackground(notifyNewMessage(db, push, config, card, null), config.logger);
    res.status(202).end();
  });

  router.post('/push/test', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    const payload: PushPayload = {
      kind: 'test',
      title: 'Notifications work',
      body: 'This is how new messages will reach you.',
      bodyPrefix: '',
      urgent: false,
      tag: 'test',
      conversationId: null,
      messageId: null,
      senderId: null,
      clientId: null,
      envelope: null,
      unreadTotal: null,
      sentAt: Date.now(),
      url: null,
    };
    res.json(await push.sendToUser(me.id, payload));
  });

  router.use((_req, _res) => {
    throw new HttpError(404, 'Not found.');
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status ?? 500;
    if (status >= 500) config.logger.error('API error', error);
    const message = error instanceof HttpError || status < 500 ? (error as Error).message : 'Something went wrong.';
    res.status(status).json({ error: message, code: error instanceof HttpError ? error.code : undefined });
  });

  return router;
}
