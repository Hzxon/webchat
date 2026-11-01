import { waitUntil } from '@vercel/functions';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  dummyPasswordHash,
  hashPassword,
  hashToken,
  newSessionToken,
  parseCookies,
  safeEqual,
  SESSION_COOKIE,
  verifyPassword,
} from './auth.js';
import type { Config } from './config.js';
import { keyBackupOf, toUserDTO, type Db, type ProjectChangeRefusal, type SharedChannelKey, type UserRow } from './db.js';
import { GithubError, type Github } from './github.js';
import { notifyAddedToGroup, notifyAddedToProject, notifyNewMessage } from './notify.js';
import type { Push, PushSubscriptionInput } from './push.js';
import {
  LIMITS,
  type AccountKeysInput,
  type BootstrapDTO,
  type ChatKeyInput,
  type ConfigDTO,
  type CreateProjectResponse,
  type EnvelopeDTO,
  type LoginResponse,
  type MessageDTO,
  type MessageKind,
  type PushPayload,
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

/** Channel names follow Slack: lowercase letters and digits in any script, joined by single hyphens. */
const CHANNEL_NAME = /^[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+(-[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}]+)*$/u;

function channelName(value: unknown): string {
  const name = text(value, 'Channel name', 1, LIMITS.channelNameLength);
  if (!CHANNEL_NAME.test(name)) throw new HttpError(400, 'Channel names use lowercase letters, numbers and single hyphens.');
  return name;
}

/** Turns a refused project change into the error the client acts on. */
function projectRefusal(refusal: ProjectChangeRefusal): HttpError {
  if (refusal === 'name_taken') return new HttpError(409, 'This project already has a channel with that name.', 'name_taken');
  if (refusal === 'already_member') return new HttpError(409, 'Someone you picked is already in this project.', 'already_member');
  return new HttpError(409, 'The project changed while you were editing. Try again.', 'stale_project');
}

function envelope(value: unknown): EnvelopeDTO {
  const e = value as Partial<EnvelopeDTO> | undefined;
  if (e?.v !== 1) throw new HttpError(400, 'Messages must be encrypted.');
  return {
    v: 1,
    kid: base64url(e.kid, 'Chat key id', 22),
    iv: base64url(e.iv, 'Message', 16),
    ct: base64url(e.ct, 'Message', 22, LIMITS.ciphertextLength),
    // A P-256 signature is 64 bytes.
    sig: base64url(e.sig, 'Signature', 86),
  };
}

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

/** Keeps a serverless function alive until background work (like sending pushes) finishes. */
function inBackground(work: Promise<unknown>) {
  waitUntil(work);
}

interface ApiDeps {
  db: Db;
  push: Push;
  github: Github;
  config: Config;
  inviteCode: string;
  kdfSalt: string;
}

export function createApiRouter({ db, push, github, config, inviteCode, kdfSalt }: ApiDeps) {
  const router = express.Router();

  function startSession(req: Request, res: Response, user: UserRow) {
    const { token, tokenHash } = newSessionToken();
    const maxAge = config.sessionDays * 24 * 3600_000;
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
    return db.createSession(tokenHash, user.id, Date.now() + maxAge);
  }

  async function limitAuth(req: Request, _res: Response, next: NextFunction) {
    if (!(await db.takeRateLimit(`auth:${req.ip ?? 'unknown'}`, 20, 15 * 60_000))) {
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

  /** Only the person who made a project can remove people from it or delete it. */
  async function requireProjectOwner(projectId: number, userId: number) {
    await requireProjectMember(projectId, userId);
    if ((await db.getProject(projectId))?.created_by !== userId) {
      throw new HttpError(403, 'Only the person who made this project can do that.', 'not_owner');
    }
  }

  /** The same for a group. A group without an owner (see ConversationDTO.createdBy) is up to any member. */
  async function requireGroupOwner(conversationId: number, userId: number) {
    await requireMember(conversationId, userId);
    const chat = await db.getConversation(conversationId);
    if (chat?.type !== 'group') throw new HttpError(400, 'Only a group can be deleted or have people removed.');
    if (chat.created_by !== null && chat.created_by !== userId) {
      throw new HttpError(403, 'Only the person who made this group can do that.', 'not_owner');
    }
  }

  /** A chat key can only be wrapped for people who have set up encryption. */
  async function requireKeys(userIds: number[]) {
    for (const id of userIds) {
      const user = await db.getUser(id);
      if (!user) throw new HttpError(404, 'Person not found.');
      if (!user.dh_public) {
        throw new HttpError(409, `${user.display_name} has not set up encryption yet. They need to sign in again.`, 'no_keys');
      }
    }
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
    await startSession(req, res, user);
    inBackground(db.purgeExpired());
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
    res.json(toUserDTO(updated));
  });

  router.post('/auth/logout', requireAuth, async (_req, res) => {
    await db.deleteSession(res.locals.sessionHash!);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/bootstrap', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    const [users, projects, conversations, cursor, stamp] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      db.latestMessageId(me.id),
      db.stamp(me.id),
    ]);
    const now = Date.now();
    const body: BootstrapDTO = {
      me: toUserDTO(me, now),
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      cursor,
      stamp,
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

    await db.checkIn(me.id, input.attentive === true, tabId, endpoint);
    const stamp = await db.stamp(me.id);
    if (stamp === input.stamp) {
      const body: SyncResponse = { changed: false, stamp, cursor };
      return res.json(body);
    }

    const messages = await db.messagesSince(me.id, cursor);
    await markDeliveredFrom(me.id, messages);
    const [users, projects, conversations, newStamp] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      // Marking messages delivered changes the fingerprint, so read it again.
      db.stamp(me.id),
    ]);
    const now = Date.now();
    const body: SyncResponse = {
      changed: true,
      stamp: newStamp,
      cursor: messages.reduce((max, m) => Math.max(max, m.id), cursor),
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      messages,
    };
    res.json(body);
  });

  /** Sent with navigator.sendBeacon when a tab closes, so pushes go to the phone right away. */
  router.post('/away', requireAuth, async (req, res) => {
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId.slice(0, 64) : '';
    await db.checkIn(currentUser(res).id, false, tabId, null);
    res.status(204).end();
  });

  router.post('/conversations/direct', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const otherId = positiveInt(req.body?.userId, 'userId');
    if (otherId === me.id || !(await db.getUser(otherId))) throw new HttpError(404, 'Person not found.');
    let id = await db.findDirect(me.id, otherId);
    if (id === undefined) {
      const memberIds = [me.id, otherId];
      await requireKeys(memberIds);
      const key = chatKey(req.body?.key, memberIds);
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
    const key = chatKey(req.body?.key, allIds);
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
    inBackground(notifyAddedToGroup(push, config, group, me, added));
    res.json(group);
  });

  /** Removes someone from a group. The owner's browser sends its key wrapped again for the people who stay. */
  router.delete('/conversations/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireGroupOwner(conversationId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    // Whether the key covers exactly the people who stay is checked while the group is locked.
    const key = req.body?.key == null ? null : wrappedChatKey(req.body.key);
    if (!(await db.removeGroupMember(conversationId, me.id, userId, key))) {
      throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
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
    const key = chatKey(req.body?.key, allIds);
    const { projectId, channelId } = await db.createProject(name, me.id, allIds, key);
    const project = (await db.projectFor(me.id, projectId))!;
    if (memberIds.length > 0) inBackground(notifyAddedToProject(push, config, project, channelId, me, memberIds));
    const body: CreateProjectResponse = { project, channel: (await db.conversationFor(me.id, channelId))! };
    res.status(201).json(body);
  });

  router.post('/projects/:id/channels', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const name = channelName(req.body?.name);
    // Whether the key covers exactly the project's members is checked while the project is locked.
    const created = await db.createChannel(projectId, name, me.id, wrappedChatKey(req.body?.key));
    if (typeof created !== 'number') throw projectRefusal(created);
    res.status(201).json(await db.conversationFor(me.id, created));
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
    const project = (await db.projectFor(me.id, projectId))!;
    // #general is the project's first channel.
    const general = channelKeys.length > 0 ? Math.min(...channelKeys.map((k) => k.conversationId)) : null;
    inBackground(notifyAddedToProject(push, config, project, general, me, added));
    res.json(project);
  });

  /**
   * Removes someone from a project and every channel in it. The owner's browser sends each channel
   * key wrapped again for the people who stay, so every copy left was made by a member.
   */
  router.delete('/projects/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireProjectOwner(projectId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    const list: unknown[] = Array.isArray(req.body?.channelKeys) ? req.body.channelKeys : [];
    // Whether the keys cover exactly the people who stay is checked while the project is locked.
    const channelKeys: SharedChannelKey[] = list.map((item) => {
      const k = item as { conversationId?: unknown } | undefined;
      return { conversationId: positiveInt(k?.conversationId, 'conversationId'), ...wrappedChatKey(item) };
    });
    const result = await db.removeProjectMember(projectId, me.id, userId, channelKeys);
    if (result !== true) throw projectRefusal(result);
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

  /** Sets the key of a chat from before encryption. The first member to send a message does this. */
  router.post('/conversations/:id/key', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    const memberIds = await db.memberIds(conversationId);
    await requireKeys(memberIds);
    const key = chatKey(req.body, memberIds);
    if (!(await db.setConversationKey(conversationId, key.keyId, me.id, key.wrappedKeys))) {
      throw new HttpError(409, 'This chat already has a key.', 'has_key');
    }
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
    const kind: MessageKind = req.body?.kind === 'reaction' ? 'reaction' : 'message';
    if (req.body?.kind !== undefined && req.body.kind !== kind) throw new HttpError(400, 'Unknown message kind.');
    await requireMember(conversationId, me.id);
    const keyId = await db.conversationKeyId(conversationId);
    if (!keyId) throw new HttpError(409, 'Set up encryption for this chat first.', 'no_chat_key');
    if (sealed.kid !== keyId) throw new HttpError(409, 'This chat uses a different key. Reload and try again.', 'stale_key');
    if (!(await db.takeRateLimit(`send:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');

    const urgent = req.body?.urgent === true;
    // The urgent flag is signed into the envelope, so it is refused rather than quietly dropped.
    if (urgent && kind === 'reaction') throw new HttpError(400, 'A reaction cannot be urgent.');
    const message = await db.insertMessage(conversationId, me.id, kind, sealed, urgent, clientId);
    // Answer the sender first; pushes go out after, while the function stays alive.
    inBackground(notifyNewMessage(db, push, config, message, me));
    res.status(201).json(message);
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
    await db.savePushSubscription(me.id, endpoint, p256dh, auth);
    res.status(204).end();
  });

  router.post('/push/unsubscribe', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (typeof req.body?.endpoint === 'string') await db.deleteUserPushSubscription(req.body.endpoint, me.id);
    res.status(204).end();
  });

  /** Where GitHub sends the user back. It must match the callback URL registered on the OAuth App. */
  const githubCallbackUrl = (req: Request) =>
    config.githubCallbackUrl ?? `${req.protocol}://${req.get('host')}/api/github/callback`;

  /** The linked GitHub account and its pull requests, fetched again first when the last poll is old. */
  router.get('/github', requireAuth, async (req, res) => {
    const me = currentUser(res);
    await github.refresh(me.id, queryOf(req).get('refresh') === '1');
    res.json(await github.view(me.id));
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
    if (typeof req.body?.notify !== 'boolean') throw new HttpError(400, 'notify must be true or false.');
    await github.setNotify(me.id, req.body.notify);
    res.json(await github.view(me.id));
  });

  router.delete('/github', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    await github.disconnect(me.id);
    res.json(await github.view(me.id));
  });

  /**
   * Polls every connected account that is due. Vercel Cron, or any scheduler, calls it with
   * "Authorization: Bearer <CRON_SECRET>", so alerts arrive while every tab is closed.
   */
  router.get('/github/poll', async (req, res) => {
    if (!config.cronSecret || !safeEqual(req.get('authorization') ?? '', `Bearer ${config.cronSecret}`)) {
      throw new HttpError(401, 'Send the CRON_SECRET as a bearer token.');
    }
    res.json({ polled: await github.pollAll() });
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
