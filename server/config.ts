import path from 'node:path';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface Config {
  port: number;
  host: string;
  /** Postgres connection string (Supabase in production). When unset, an embedded PGlite database is used. */
  databaseUrl: string | undefined;
  /** PEM certificate for verifying the Postgres server, e.g. Supabase's root CA. */
  databaseCaCert: string | undefined;
  /** Folder for the embedded database, or ":memory:" for tests. Used only without databaseUrl. */
  pgliteDir: string;
  /** Code friends must enter to register. Generated and stored in the database when unset. */
  inviteCode: string | undefined;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  /** Contact for push services: a mailto: address or an https URL (not localhost; Safari rejects it). */
  vapidSubject: string;
  /** Express "trust proxy" setting. Set it when running behind a reverse proxy that terminates HTTPS. */
  trustProxy: boolean | number | string;
  sessionDays: number;
  /** Extra push endpoint hosts to accept, any protocol. Meant for tests only. */
  extraPushHosts: string[];
  /** Built client to serve, or null to serve the API only (Vercel and the Vite dev server serve the client). */
  clientDir: string | null;
  /** GitHub OAuth App credentials. The GitHub connector stays off until both are set. */
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;
  /** Callback URL registered on the OAuth App. When unset, it follows the address the request came to. */
  githubCallbackUrl: string | undefined;
  /** Base URLs of GitHub's sign-in pages and API. Meant for tests only. */
  githubOauthUrl: string;
  githubApiUrl: string;
  /** How often the server checks every connected account on its own. 0 turns it off; Vercel never does. */
  githubPollSeconds: number;
  /** Bearer token that GET /api/github/poll requires, so a scheduler can trigger checks. */
  cronSecret: string | undefined;
  logger: Logger;
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) ? hops : value;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error ?? ''),
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const onVercel = Boolean(env.VERCEL);
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    // The Supabase integration on Vercel names it POSTGRES_URL.
    databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || undefined,
    databaseCaCert: env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') || undefined,
    pgliteDir: env.PGLITE_DIR ?? path.resolve('data', 'pglite'),
    inviteCode: env.INVITE_CODE || undefined,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || undefined,
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || undefined,
    // On Vercel, default to the site's own production address.
    vapidSubject:
      env.VAPID_SUBJECT ||
      (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'mailto:webchat@example.com'),
    // Vercel terminates HTTPS in front of the function.
    trustProxy: onVercel ? true : parseTrustProxy(env.TRUST_PROXY),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    extraPushHosts: (env.EXTRA_PUSH_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    clientDir:
      onVercel || env.SERVE_CLIENT === 'false' ? null : path.resolve(env.CLIENT_DIR ?? path.join('dist', 'client')),
    githubClientId: env.GITHUB_CLIENT_ID || undefined,
    githubClientSecret: env.GITHUB_CLIENT_SECRET || undefined,
    githubCallbackUrl: env.GITHUB_CALLBACK_URL || undefined,
    githubOauthUrl: env.GITHUB_OAUTH_URL || 'https://github.com',
    githubApiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    // Serverless instances stop between requests, so on Vercel a scheduler calls /api/github/poll instead.
    githubPollSeconds: onVercel ? 0 : Number(env.GITHUB_POLL_SECONDS ?? 120),
    cronSecret: env.CRON_SECRET || undefined,
    logger: consoleLogger,
  };
}
