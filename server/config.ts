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
  /**
   * Bark's APNs key, which its author publishes for self-hosted servers, so WebChat can alert the
   * Bark app on iPhones without Web Push (R-018). Those alerts stay off until it is set. The key id
   * and team id default to Bark's own.
   */
  barkApnsKey: string | undefined;
  barkApnsKeyId: string;
  barkApnsTeamId: string;
  /** Apple's push gateway. Meant for tests only. */
  apnsOrigin: string;
  /** Built client to serve, or null to serve the API only (Vercel and the Vite dev server serve the client). */
  clientDir: string | null;
  /** GitHub OAuth App credentials, for each person's Pull requests pane. It stays off until both are set. */
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;
  /** Callback URL registered on the OAuth App. When unset, it follows the address the request came to. */
  githubCallbackUrl: string | undefined;
  /**
   * The GitHub App that projects link repositories through (D-050): the name in its URL, its OAuth
   * client, and the secret that signs its webhooks. Linking stays off until all four are set.
   */
  githubAppSlug: string | undefined;
  githubAppClientId: string | undefined;
  githubAppClientSecret: string | undefined;
  githubWebhookSecret: string | undefined;
  /** A callback URL registered on the GitHub App. When unset, it follows the address the request came to. */
  githubAppCallbackUrl: string | undefined;
  /** Base URLs of GitHub's sign-in pages and API. Meant for tests only. */
  githubOauthUrl: string;
  githubApiUrl: string;
  /** How often the server checks every connected account on its own. 0 turns it off; Vercel never does. */
  githubPollSeconds: number;
  /** Bearer token that GET /api/github/poll requires, so a scheduler can trigger checks. */
  cronSecret: string | undefined;
  /**
   * The address of GET /api/github/poll that the database's own scheduler calls. Set on Vercel
   * only: nothing runs there between requests, and a long-running server has its own timer.
   */
  githubPollUrl: string | undefined;
  /** The address of GET /api/urgent/ring that the database's own scheduler calls. Set on Vercel only, as above. */
  urgentRingUrl: string | undefined;
  /**
   * Names the running build. Every API response carries it, and a tab reloads when it changes, so a
   * page from before a deploy does not show new data as errors. When unset, the built page is hashed.
   */
  build: string | undefined;
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
    barkApnsKey: env.BARK_APNS_KEY?.replace(/\\n/g, '\n') || undefined,
    barkApnsKeyId: env.BARK_APNS_KEY_ID || 'LH4T9V5U4R',
    barkApnsTeamId: env.BARK_APNS_TEAM_ID || '5U8LBRXG3A',
    apnsOrigin: env.APNS_ORIGIN || 'https://api.push.apple.com',
    clientDir:
      onVercel || env.SERVE_CLIENT === 'false' ? null : path.resolve(env.CLIENT_DIR ?? path.join('dist', 'client')),
    githubClientId: env.GITHUB_CLIENT_ID || undefined,
    githubClientSecret: env.GITHUB_CLIENT_SECRET || undefined,
    githubCallbackUrl: env.GITHUB_CALLBACK_URL || undefined,
    githubAppSlug: env.GITHUB_APP_SLUG || undefined,
    githubAppClientId: env.GITHUB_APP_CLIENT_ID || undefined,
    githubAppClientSecret: env.GITHUB_APP_CLIENT_SECRET || undefined,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    githubAppCallbackUrl: env.GITHUB_APP_CALLBACK_URL || undefined,
    githubOauthUrl: env.GITHUB_OAUTH_URL || 'https://github.com',
    githubApiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    // Serverless instances stop between requests, so on Vercel a scheduler calls /api/github/poll instead.
    githubPollSeconds: onVercel ? 0 : Number(env.GITHUB_POLL_SECONDS ?? 120),
    cronSecret: env.CRON_SECRET || undefined,
    githubPollUrl:
      onVercel && env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/api/github/poll`
        : undefined,
    urgentRingUrl:
      onVercel && env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/api/urgent/ring`
        : undefined,
    // Vercel names each deployment. Elsewhere, WEBCHAT_BUILD can name it, or the built page is hashed.
    build: env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || env.WEBCHAT_BUILD || undefined,
    logger: consoleLogger,
  };
}
