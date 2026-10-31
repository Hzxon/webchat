import fs from 'node:fs';
import path from 'node:path';
import { attachDatabasePool } from '@vercel/functions';
import express from 'express';
import { createApiRouter } from './api.js';
import { randomInviteCode } from './auth.js';
import type { Config } from './config.js';
import { openDb } from './db.js';
import { createPush } from './push.js';
import { connectPostgres, openPglite, type Sql } from './sql.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
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
  close(): Promise<void>;
}

async function connect(config: Config): Promise<Sql> {
  if (!config.databaseUrl) return openPglite(config.pgliteDir);
  const sql = connectPostgres({ connectionString: config.databaseUrl, caCert: config.databaseCaCert });
  // On Vercel, closes idle connections before the function instance is suspended.
  attachDatabasePool(sql.pool);
  return sql;
}

/** Builds the Express app. It does not listen: server/index.ts does locally, and Vercel does in production. */
export async function createApp(config: Config): Promise<WebChatApp> {
  const db = await openDb(await connect(config));

  const inviteCode = config.inviteCode ?? (await db.claimMeta('invite_code', randomInviteCode()));

  const push = await createPush(db, config);
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }), createApiRouter({ db, push, config, inviteCode }));

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

  return { app, inviteCode, close: () => db.close() };
}
