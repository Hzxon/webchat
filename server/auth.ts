import crypto from 'node:crypto';

export const SESSION_COOKIE = 'webchat_sid';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };

function scrypt(password: string, salt: Buffer, keyLength: number, options: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Returns "scrypt$N$r$p$salt$hash" so the cost can change later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keyLength } = SCRYPT;
  const key = await scrypt(password, salt, keyLength, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

/** Hash of a password nobody has, used to keep login timing the same for unknown usernames. */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

/** The cookie holds the token; the database stores only its hash, so a leaked database cannot log anyone in. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function randomInviteCode(): string {
  return crypto.randomBytes(6).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}
