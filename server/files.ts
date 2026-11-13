// Where the ciphertext of photos and files lives (R-005, D-123). The server only ever hands out
// addresses: a member's client uploads with one PUT and downloads with one GET, so neither goes
// through a function, whose bodies Vercel caps at 4.5 MB. On Vercel the addresses are presigned
// URLs of a private Blob store; a self-hosted server serves them itself from a folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { del, issueSignedToken, presignUrl } from '@vercel/blob';
import express from 'express';
import { FILE_ID, FILE_OVERHEAD } from '../shared/e2ee.js';
import { LIMITS } from '../shared/types.js';
import { safeEqual } from './auth.js';

export interface FileStore {
  /** An address that takes one PUT of at most `size` bytes until `until` (ms). */
  uploadUrl(id: string, size: number, until: number): Promise<string>;
  /** An address that answers a GET with the ciphertext until `until` (ms). */
  downloadUrl(id: string, until: number): Promise<string>;
  delete(ids: string[]): Promise<void>;
  /** The routes behind a self-hosted store's addresses, which take raw bodies and go before the JSON parser. */
  router?: express.Router;
}

/**
 * Vercel Blob, private, with signed URLs (SDK 2.9). Each address needs its own token, scoped to one
 * pathname, since a token is a call to Blob's API anyway. The upload's ttl lets Blob drop the
 * ciphertext on its own a day after the server stops giving it out. Unverified until a store
 * exists: that a page may PUT to vercel.com/api/blob and GET from the store's host (CORS).
 */
export function blobStore(): FileStore {
  const pathname = (id: string) => `files/${id}`;
  return {
    async uploadUrl(id, size, until) {
      const token = await issueSignedToken({ pathname: pathname(id), operations: ['put'], maximumSizeInBytes: size, validUntil: until });
      const options = { maximumSizeInBytes: size, addRandomSuffix: false, allowOverwrite: false, ttlDays: LIMITS.fileDays + 1 };
      return (await presignUrl(token, { operation: 'put', pathname: pathname(id), access: 'private', ...options })).presignedUrl;
    },
    async downloadUrl(id, until) {
      const token = await issueSignedToken({ pathname: pathname(id), operations: ['get'], validUntil: until });
      return (await presignUrl(token, { operation: 'get', pathname: pathname(id), access: 'private' })).presignedUrl;
    },
    delete: async (ids) => {
      if (ids.length > 0) await del(ids.map(pathname));
    },
  };
}

/**
 * A folder on a self-hosted server. Its addresses are routes of the app signed with a secret of the
 * deployment, so they work for any member's client with no session, as presigned URLs do.
 */
export function diskStore(dir: string, secret: string): FileStore {
  const sign = (op: string, id: string, size: number, until: number) =>
    crypto.createHmac('sha256', secret).update(`${op}:${id}:${size}:${until}`).digest('base64url');
  const address = (op: string, id: string, size: number, until: number) =>
    `/api/files/${id}/data?${new URLSearchParams({ size: String(size), until: String(until), sig: sign(op, id, size, until) })}`;

  /** The id and size an address was signed for, or nothing. Query strings through the URL API (D-012). */
  function signed(req: express.Request, op: string) {
    const id = String(req.params.id);
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const [size, until] = [Number(query.get('size')), Number(query.get('until'))];
    const valid = FILE_ID.test(id) && until > Date.now() && safeEqual(query.get('sig') ?? '', sign(op, id, size, until));
    return valid ? { file: path.join(dir, id), size } : undefined;
  }

  const router = express.Router();
  router.put('/files/:id/data', express.raw({ type: () => true, limit: LIMITS.fileBytes + FILE_OVERHEAD }), async (req, res) => {
    const target = signed(req, 'put');
    if (!target) return void res.status(403).json({ error: 'This upload address is not valid.' });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length > target.size) return void res.status(413).json({ error: 'The file is larger than its upload address allows.' });
    await fs.promises.mkdir(dir, { recursive: true });
    // "wx": an address takes one upload, and never replaces a file.
    await fs.promises.writeFile(target.file, body, { flag: 'wx' });
    res.status(204).end();
  });
  router.get('/files/:id/data', (req, res) => {
    const target = signed(req, 'get');
    if (!target || !fs.existsSync(target.file)) return void res.status(404).json({ error: 'File not found.' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(target.file).pipe(res);
  });

  return {
    uploadUrl: async (id, size, until) => address('put', id, size, until),
    downloadUrl: async (id, until) => address('get', id, 0, until),
    delete: async (ids) => {
      await Promise.all(ids.map((id) => fs.promises.rm(path.join(dir, id), { force: true })));
    },
    router,
  };
}
