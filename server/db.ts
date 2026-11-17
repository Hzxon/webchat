import type { Sql } from './sql.js';
import { MIGRATIONS, SCHEMA, statements } from './db/schema.js';
import { one } from './db/rows.js';
export { MIGRATIONS } from './db/schema.js';
export { ATTENTION_TTL_MS, GITHUB_POLL_JOB, URGENT_RING_SECONDS, URGENT_RING_JOB, toUserDTO, keyBackupOf, isAttentive } from './db/rows.js';
export type { FileRow, UserRow, GithubAccountRow, DatabaseJob, GithubRepoGrant, ProjectRow, SharedChannelKey, ProjectChangeRefusal, LeaveRefusal, PushSubscriptionRow, BarkLinkRow, BarkDeviceRow } from './db/rows.js';
import { systemQueries } from './db/system.js';
import { accountsQueries } from './db/accounts.js';
import { filesQueries } from './db/files.js';
import { conversationsQueries } from './db/conversations.js';
import { projectsQueries } from './db/projects.js';
import { messagesQueries } from './db/messages.js';
import { docsQueries } from './db/docs.js';
import { pushQueries } from './db/push.js';
import { barkQueries } from './db/bark.js';
import { githubQueries } from './db/github.js';
import { createHelpers } from './db/helpers.js';

export type Db = Awaited<ReturnType<typeof openDb>>;

/** Wraps a connection in the app's queries. Creates the tables on first use. */
export async function openDb(sql: Sql) {
  await sql.transaction(async (tx) => {
    // Several serverless instances can start at once; the lock makes them create tables one at a time.
    await tx.query('SELECT pg_advisory_xact_lock(7349201)');
    // One statement per query: PGlite's query() does not accept several at once.
    for (const statement of statements(SCHEMA)) await tx.query(statement);
    const version = Number(
      (await one(tx.query<{ value: string }>("SELECT value FROM webchat.meta WHERE key = 'schema_version'")))?.value ?? 0,
    );
    for (const migration of MIGRATIONS.slice(version)) {
      for (const statement of statements(migration)) await tx.query(statement);
    }
    if (version < MIGRATIONS.length) {
      await tx.query(
        `INSERT INTO webchat.meta (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(MIGRATIONS.length)],
      );
    }
  });

  const helpers = createHelpers(sql);

  return {
    ...systemQueries(sql, helpers),
    ...accountsQueries(sql, helpers),
    ...filesQueries(sql, helpers),
    ...conversationsQueries(sql, helpers),
    ...projectsQueries(sql, helpers),
    ...messagesQueries(sql, helpers),
    ...docsQueries(sql, helpers),
    ...pushQueries(sql, helpers),
    ...barkQueries(sql, helpers),
    ...githubQueries(sql, helpers),
  };
}
