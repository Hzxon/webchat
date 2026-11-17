import { waitUntil } from '@vercel/functions';
import { type Request, type Response } from 'express';
import type { Config } from '../config.js';
import { type LeaveRefusal, type ProjectChangeRefusal, type UserRow } from '../db.js';
import { isChannelName, isRepoName, LIMITS, type AccountKeysInput, type ChatKeyInput, type EnvelopeDTO, type KeyLinkInput, type RotatedChannelKeyInput, type RotatedKeyInput, type SyncRequest } from '../../shared/types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      user?: UserRow;
      sessionHash?: string;
    }
  }
}

export class HttpError extends Error {
  status: number;
  /** Machine-readable reason the client acts on, such as "upgrade_required". */
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const USERNAME = /^[a-z0-9_.]{3,24}$/i;

/** Holds the OAuth state while the user signs in on GitHub. Only the GitHub routes ever see it. */
export const GITHUB_STATE_COOKIE = 'webchat_github';
/** Holds the project, and the GitHub App sign-in's state, while a project's owner links a repository on GitHub. */
export const GITHUB_APP_COOKIE = 'webchat_github_app';

export function text(value: unknown, field: string, min: number, max: number): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max) {
    throw new HttpError(400, `${field} must be ${min}-${max} characters.`);
  }
  return result;
}

export const MAX_ID = 2_147_483_647; // Postgres INTEGER

export function positiveInt(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0 || result > MAX_ID) throw new HttpError(400, `${field} is invalid.`);
  return result;
}

export const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Checks a base64url field's length. Exact lengths follow from the key and IV sizes in shared/e2ee.ts. */
export function base64url(value: unknown, field: string, min: number, max = min): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || !BASE64URL.test(value)) {
    throw new HttpError(400, `${field} is invalid.`);
  }
  return value;
}

/** 32-byte login key the browser derives from the password. */
export const loginKey = (body: unknown) => base64url((body as { authKey?: unknown } | undefined)?.authKey, 'Login key', 43);

export function accountKeys(value: unknown): AccountKeysInput {
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
export function wrappedChatKey(value: unknown): ChatKeyInput {
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
export function rotatedKey(value: unknown): RotatedKeyInput {
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
export function chatKey(value: unknown, memberIds: number[]): ChatKeyInput {
  const key = wrappedChatKey(value);
  const ids = new Set(key.wrappedKeys.map((k) => k.userId));
  if (ids.size !== memberIds.length || memberIds.some((id) => !ids.has(id))) {
    throw new HttpError(400, 'The chat key must be wrapped once for every member.');
  }
  return key;
}

/** A list of distinct user ids, without the given one. */
export function userIds(value: unknown, field: string, without: number): number[] {
  const raw: unknown[] = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((v) => positiveInt(v, field)))].filter((id) => id !== without);
}

export function channelName(value: unknown): string {
  const name = text(value, 'Channel name', 1, LIMITS.channelNameLength);
  if (!isChannelName(name)) throw new HttpError(400, 'Channel names use lowercase letters, numbers and single hyphens.');
  return name;
}

/** GitHub's ids outgrow a Postgres INTEGER, so they get their own check. */
export function githubId(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new HttpError(400, `${field} is invalid.`);
  return result;
}

/** Turns a refused project change into the error the client acts on. */
export function projectRefusal(refusal: ProjectChangeRefusal): HttpError {
  if (refusal === 'name_taken') return new HttpError(409, 'This project already has a channel with that name.', 'name_taken');
  if (refusal === 'already_member') return new HttpError(409, 'Someone you picked is already in this project.', 'already_member');
  if (refusal === 'owner') return new HttpError(409, 'Make someone else the owner before you leave.', 'owner');
  return new HttpError(409, 'The project changed while you were editing. Try again.', 'stale_project');
}

export function leaveRefusal(refusal: LeaveRefusal): HttpError {
  if (refusal === 'owner') return new HttpError(409, 'Make someone else the owner before you leave.', 'owner');
  if (refusal === 'last_member') return new HttpError(409, 'You are the last member. Delete the group instead.', 'last_member');
  return new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
}

export function rotatedChannelKeys(value: unknown): RotatedChannelKeyInput[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return list.map((item) => {
    const k = item as { conversationId?: unknown } | undefined;
    return { conversationId: positiveInt(k?.conversationId, 'conversationId'), ...rotatedKey(item) };
  });
}

export function envelope(value: unknown, maxLength: number = LIMITS.ciphertextLength): EnvelopeDTO {
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
export function checkedInRepos({ repos, repo }: Partial<SyncRequest>) {
  const named = Array.isArray(repos) ? repos.slice(0, LIMITS.agentRepos) : [repo];
  return [...new Set(named.filter((r): r is string => typeof r === 'string' && isRepoName(r)))];
}

export const docId = (value: unknown) => base64url(value, 'Doc id', 22);

/** "title", or the 8 random bytes a browser names a section with. */
export const docSection = (value: unknown) => (value === 'title' ? value : base64url(value, 'Section', 11));

export function currentUser(res: Response): UserRow {
  const user = res.locals.user;
  if (!user) throw new HttpError(401, 'Sign in first.');
  return user;
}

/**
 * The query string, read with the WHATWG URL API. Reading req.query makes Express call Node's
 * url.parse(), which logs a deprecation warning (DEP0169) on Vercel.
 */
export const queryOf = (req: Request) => new URL(req.originalUrl, 'http://localhost').searchParams;

/**
 * Keeps a serverless function alive until background work (like sending pushes) finishes. Off
 * Vercel, waitUntil ignores the promise, so an unhandled failure here would stop the Node process.
 */
export function inBackground(work: Promise<unknown>, logger: Config['logger']) {
  waitUntil(work.catch((error: unknown) => logger.error('Background work failed', error)));
}
