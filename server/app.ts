import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attachDatabasePool } from '@vercel/functions';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createApiRouter } from './api.js';
import { randomBytes, toBase64Url } from '../shared/e2ee.js';
import { BUILD_HEADER } from '../shared/types.js';
import { randomInviteCode } from './auth.js';
import { createBark } from './bark.js';
import { blobStore, diskStore } from './files.js';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { createGithub } from './github.js';
import { createGithubApp } from './githubApp.js';
import { ringUrgent, scheduleUrgentRings } from './notify.js';
import { createPush } from './push.js';
import { connectPostgres, openPglite, type Sql } from './sql.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // A page uploads and downloads files at the addresses of a private Vercel Blob store (D-123).
  "connect-src 'self' https://vercel.com/api/blob/ https://*.private.blob.vercel-storage.com",
  // A photo shows from the bytes the page decrypted.
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export interface WebChatApp {
  app: express.Express;
  inviteCode: string;
  /** Raw database access, for tests and maintenance scripts. */
  sql: Sql;
  /** Polls every connected GitHub account that is due. server/index.ts runs it on a timer. */
  pollGithub(): Promise<number>;
  githubConfigured: boolean;
  /** Rings the unread urgent messages again. server/index.ts runs it on a timer. */
  ringUrgent(): Promise<number>;
  close(): Promise<void>;
}

async function connect(config: Config): Promise<Sql> {
  if (!config.databaseUrl) return openPglite(config.pgliteDir);
  const sql = connectPostgres({ connectionString: config.databaseUrl, caCert: config.databaseCaCert });
  // On Vercel, closes idle connections before the function instance is suspended.
  attachDatabasePool(sql.pool);
  return sql;
}

/**
 * Names the build for the tabs. Without a name from the configuration, the built page stands in:
 * its script tags carry the bundle hashes, so it changes with every client build and with
 * nothing else. Null with no built page, as in tests and in development without a build.
 */
function buildId(config: Config): string | null {
  if (config.build) return config.build;
  const indexPath = config.clientDir && path.join(config.clientDir, 'index.html');
  if (!indexPath || !fs.existsSync(indexPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('base64url').slice(0, 16);
}

/** Builds the Express app. It does not listen: server/index.ts does locally, and Vercel does in production. */
export async function createApp(config: Config): Promise<WebChatApp> {
  const sql = await connect(config);
  const db = await openDb(sql);
  const build = buildId(config);

  const inviteCode = config.inviteCode ?? (await db.claimMeta('invite_code', randomInviteCode()));
  // Mixed into every password key derivation, so keys from one deployment are useless on another.
  const kdfSalt = await db.claimMeta('kdf_salt', toBase64Url(randomBytes(16)));

  const bark = createBark(db, config);
  const push = await createPush(db, config, bark);
  const github = createGithub(db, push, config);
  await Promise.all([github.schedulePolls(), scheduleUrgentRings(db, config)]);
  const githubApp = createGithubApp(db, config);
  const files = config.blobStore
    ? blobStore()
    : config.filesDir
      ? diskStore(config.filesDir, await db.claimMeta('files_secret', toBase64Url(randomBytes(32))))
      : null;
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });
  if (build) {
    app.use('/api', (_req, res, next) => {
      res.setHeader(BUILD_HEADER, build);
      next();
    });
  }
  // GitHub signs the webhook's exact bytes, so that route gets them unparsed. A pull request's
  // description alone can be 65,536 characters. The JSON parser below leaves a parsed body alone.
  app.use('/api/github/webhook', express.raw({ type: () => true, limit: '1mb' }));
  // A self-hosted store's uploads are raw bytes, larger than any JSON body.
  if (files?.router) app.use('/api', files.router);
  // Room for a project's wrapped channel keys and the longest encrypted message (D-011).
  app.use(
    '/api',
    express.json({ limit: '256kb' }),
    createApiRouter({ db, push, bark, github, githubApp, files, config, inviteCode, kdfSalt }),
  );
  // The body parser runs before the API router, so its errors never reach the router's handler.
  // Answer them as JSON too, which the page can show, and without Express's stack-trace page.
  app.use('/api', (error: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status ?? 500;
    if (status >= 500) config.logger.error('API error', error);
    const message =
      error.type === 'entity.too.large'
        ? 'This change is too large to send at once.'
        : status < 500
          ? 'The request could not be read.'
          : 'Something went wrong.';
    res.status(status).json({ error: message });
  });

  const clientDir = config.clientDir;
  if (clientDir && fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(
      express.static(clientDir, {
        setHeaders(res, filePath) {
          // Hashed bundles never change. The page and the service worker must always be re-checked.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
  } else if (clientDir) {
    config.logger.warn(`No built client in ${clientDir}. Run "npm run build", or use "npm run dev".`);
  }

  return {
    app,
    inviteCode,
    sql,
    pollGithub: github.pollAll,
    githubConfigured: github.configured,
    ringUrgent: () => ringUrgent(db, push),
    close: () => db.close(),
  };
}
