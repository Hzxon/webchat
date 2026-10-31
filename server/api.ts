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
import { toUserDTO, type Db, type UserRow } from './db.js';
import { notifyNewMessage } from './notify.js';
import type { Push, PushSubscriptionInput } from './push.js';
import {
  LIMITS,
  type BootstrapDTO,
  type ConfigDTO,
  type MessageDTO,
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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const USERNAME = /^[a-z0-9_.]{3,24}$/i;

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

function currentUser(res: Response): UserRow {
  const user = res.locals.user;
  if (!user) throw new HttpError(401, 'Sign in first.');
  return user;
}

/** Keeps a serverless function alive until background work (like sending pushes) finishes. */
function inBackground(work: Promise<unknown>) {
  waitUntil(work);
}

interface ApiDeps {
  db: Db;
  push: Push;
  config: Config;
  inviteCode: string;
}

export function createApiRouter({ db, push, config, inviteCode }: ApiDeps) {
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

  async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const sessionHash = token ? hashToken(token) : undefined;
    const user = sessionHash ? await db.sessionUser(sessionHash) : undefined;
    if (!user) throw new HttpError(401, 'Sign in first.');
    res.locals.user = user;
    res.locals.sessionHash = sessionHash;
    next();
  }

  async function requireMember(conversationId: number, userId: number) {
    if (!(await db.isMember(conversationId, userId))) throw new HttpError(404, 'Chat not found.');
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
    const body: ConfigDTO = { vapidPublicKey: push.publicKey };
    res.json(body);
  });

  router.post('/auth/register', limitAuth, async (req, res) => {
    const username = text(req.body?.username, 'Username', 3, 24);
    if (!USERNAME.test(username)) throw new HttpError(400, 'Username can use letters, numbers, dots and underscores.');
    const displayName = text(req.body?.displayName, 'Name', 1, LIMITS.displayNameLength);
    const password = text(req.body?.password, 'Password', 8, 200);
    if (!safeEqual(String(req.body?.inviteCode ?? '').trim(), inviteCode)) {
      throw new HttpError(403, 'Invite code is wrong. Ask the owner for it.');
    }
    const user = await db.createUser(username, displayName, await hashPassword(password));
    if (!user) throw new HttpError(409, 'That username is taken.');
    await startSession(req, res, user);
    res.status(201).json(toUserDTO(user));
  });

  router.post('/auth/login', limitAuth, async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const user = await db.findUserByUsername(username);
    // Check a dummy hash for unknown users too, so response time does not reveal which usernames exist.
    const valid = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !valid) throw new HttpError(401, 'Wrong username or password.');
    await startSession(req, res, user);
    inBackground(db.purgeExpired());
    res.json(toUserDTO(user));
  });

  router.post('/auth/logout', requireAuth, async (_req, res) => {
    await db.deleteSession(res.locals.sessionHash!);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/bootstrap', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    const [users, conversations, cursor, stamp] = await Promise.all([
      db.listUsers(),
      db.conversationsFor(me.id),
      db.latestMessageId(me.id),
      db.stamp(me.id),
    ]);
    const now = Date.now();
    const body: BootstrapDTO = {
      me: toUserDTO(me, now),
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
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
    const [users, conversations, newStamp] = await Promise.all([
      db.listUsers(),
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
    const id = (await db.findDirect(me.id, otherId)) ?? (await db.createConversation('direct', null, [me.id, otherId]));
    res.json(await db.conversationFor(me.id, id));
  });

  router.post('/conversations/group', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const title = text(req.body?.title, 'Group name', 1, LIMITS.groupTitleLength);
    const rawIds: unknown[] = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const memberIds = [...new Set(rawIds.map((v) => positiveInt(v, 'memberIds')))].filter((id) => id !== me.id);
    if (memberIds.length === 0) throw new HttpError(400, 'Pick at least one person.');
    for (const id of memberIds) if (!(await db.getUser(id))) throw new HttpError(404, 'Person not found.');
    const id = await db.createConversation('group', title, [me.id, ...memberIds]);
    res.status(201).json(await db.conversationFor(me.id, id));
  });

  router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    const before =
      req.query.before === undefined ? MAX_ID : positiveInt(req.query.before, 'before');
    res.json(await db.messagesBefore(conversationId, before, LIMITS.pageSize));
  });

  router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : null;
    if (!body) throw new HttpError(400, 'Message is empty.');
    if (body.length > LIMITS.messageLength) throw new HttpError(400, 'Message is too long.');
    await requireMember(conversationId, me.id);
    if (!(await db.takeRateLimit(`send:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');

    const message = await db.insertMessage(conversationId, me.id, body, req.body?.urgent === true, clientId);
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

  router.post('/push/test', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    const payload: PushPayload = {
      kind: 'test',
      title: 'Notifications work',
      body: 'This is how new messages will reach you.',
      urgent: false,
      tag: 'test',
      conversationId: null,
      messageId: null,
      unreadTotal: null,
      sentAt: Date.now(),
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
    res.status(status).json({ error: message });
  });

  return router;
}
