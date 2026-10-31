// Local and self-hosted entry point. On Vercel, api/index.ts serves the same app instead.
import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, inviteCode, pollGithub, githubConfigured, close } = await createApp(config);
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
config.logger.info(`WebChat is running at http://${host}:${config.port}`);
config.logger.info(`Database: ${config.databaseUrl ? 'Postgres from DATABASE_URL' : `embedded PGlite in ${config.pgliteDir}`}`);
config.logger.info(`Invite code for new accounts: ${inviteCode}`);

// A long-running server checks GitHub on its own, so pull request alerts arrive with every tab closed.
if (githubConfigured && config.githubPollSeconds > 0) {
  const poll = () => pollGithub().catch((error: unknown) => config.logger.error('GitHub poll failed', error));
  setInterval(poll, config.githubPollSeconds * 1000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    close().finally(() => process.exit(0));
  });
}
