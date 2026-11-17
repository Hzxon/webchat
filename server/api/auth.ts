import type { Router } from 'express';
import pkg from '../../package.json' with { type: 'json' };
import { DEVICE_COOKIE, dummyPasswordHash, hashPassword, parseCookies, safeEqual, SESSION_COOKIE, verifyPassword } from '../auth.js';
import { keyBackupOf, toUserDTO } from '../db.js';
import { LIMITS, type ConfigDTO, type LoginResponse, type PairingInput } from '../../shared/types.js';
import { HttpError, USERNAME, accountKeys, base64url, currentUser, inBackground, loginKey, positiveInt, text } from './helpers.js';
import type { Context } from './context.js';

export function authRoutes(router: Router, { db, push, files, config, inviteCode, kdfSalt, sweepFiles, startSession, markDevice, authLimitKey, limitAuth, requireAuth }: Context) {
  router.get('/config', (_req, res) => {
    const body: ConfigDTO = { vapidPublicKey: push.publicKey, kdfSalt, release: pkg.version, files: files !== null };
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
    inBackground(sweepFiles(), config.logger);
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
      ...(body?.picks !== undefined && { picks: base64url(body.picks, 'Picks', 40, LIMITS.pairingPicks) }),
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
    inBackground(sweepFiles(), config.logger);
    res.status(204).end();
  });
}
