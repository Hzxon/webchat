import { type NextFunction, type Request, type Response } from 'express';
import { DEVICE_COOKIE, hashToken, newSessionToken, parseCookies, SESSION_COOKIE } from '../auth.js';
import { type Bark } from '../bark.js';
import type { Config } from '../config.js';
import type { FileStore } from '../files.js';
import { type Db, type UserRow } from '../db.js';
import { type Github } from '../github.js';
import type { GithubApp } from '../githubApp.js';
import type { Push } from '../push.js';
import { type FirstChatKeyInput, type MessageDTO } from '../../shared/types.js';
import { HttpError, MAX_ID, chatKey, positiveInt, wrappedChatKey } from './helpers.js';

export interface ApiDeps {
  db: Db;
  push: Push;
  bark: Bark;
  github: Github;
  githubApp: GithubApp;
  /** Null when the server has no file store: then it offers no photos or files (R-005). */
  files: FileStore | null;
  config: Config;
  inviteCode: string;
  kdfSalt: string;
}

/** What the routes share: the services, and the guards and checks every resource uses. */
export function createContext({ db, push, bark, github, githubApp, files, config, inviteCode, kdfSalt }: ApiDeps) {
  /**
   * Deletes the ciphertext of files past their days, of uploads no message followed, and of deleted
   * chats and accounts, then their rows. With no scheduler, it runs when someone asks for an upload
   * address or deletes something (D-123).
   */
  async function sweepFiles() {
    if (!files) return;
    const ids = await db.sweepableFiles(Date.now());
    if (ids.length === 0) return;
    await files.delete(ids);
    await db.deleteFiles(ids);
  }

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

  return { db, push, bark, github, githubApp, files, config, inviteCode, kdfSalt, sweepFiles, startSession, markDevice, authLimitKey, limitAuth, sessionOf, requireAuth, requireMember, requireProjectMember, requireProjectOwner, requireGroupOwner, newOwnerOf, ownsProject, requireCurrentKey, requireDoc, requireKeys, firstKey, markDeliveredFrom };
}

export type Context = ReturnType<typeof createContext>;
