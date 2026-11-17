import { type GithubEventDTO, type RepoChoiceDTO } from '../../shared/types.js';
import { randomBytes, toBase64Url } from '../../shared/e2ee.js';
import type { Sql } from '../sql.js';
import { type DatabaseJob, GITHUB_EVENTS_KEPT, GITHUB_SCHEDULED_AT, GRANT_TTL_MS, type GithubAccountRow, type GithubEventRow, type GithubRepoGrant, JOB_SECRET, one, sqlLiteral, toGithubEventDTO } from './rows.js';
import type { Helpers } from './helpers.js';

export function githubQueries(sql: Sql, _helpers: Helpers) {
  return {

    /** Replaces the repositories someone may link with the ones they just showed GitHub they reach. */
    saveGithubGrants: (userId: number, grants: GithubRepoGrant[]) =>
      sql.transaction(async (tx) => {
        await tx.query('DELETE FROM webchat.github_app_grants WHERE user_id = $1', [userId]);
        const expiresAt = Date.now() + GRANT_TTL_MS;
        for (const g of grants) {
          await tx.query(
            `INSERT INTO webchat.github_app_grants (user_id, repo_id, repo, installation_id, expires_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, repo_id) DO NOTHING`,
            [userId, g.repoId, g.repo, g.installationId, expiresAt],
          );
        }
      }),
    /** The repositories someone may link now, without the ones this project links already. */
    githubChoices: async (userId: number, projectId: number): Promise<RepoChoiceDTO[]> =>
      (
        await sql.query<{ repo_id: number; repo: string }>(
          `SELECT g.repo_id, g.repo FROM webchat.github_app_grants g
           WHERE g.user_id = $1 AND g.expires_at > $2
             AND NOT EXISTS (SELECT 1 FROM webchat.project_repos r WHERE r.project_id = $3 AND r.repo_id = g.repo_id)
           ORDER BY lower(g.repo)`,
          [userId, Date.now(), projectId],
        )
      ).map((row) => ({ repoId: row.repo_id, repo: row.repo })),
    githubGrant: async (userId: number, repoId: number): Promise<GithubRepoGrant | undefined> => {
      const row = await one(
        sql.query<{ repo_id: number; repo: string; installation_id: number }>(
          'SELECT repo_id, repo, installation_id FROM webchat.github_app_grants WHERE user_id = $1 AND repo_id = $2 AND expires_at > $3',
          [userId, repoId, Date.now()],
        ),
      );
      return row && { repoId: row.repo_id, repo: row.repo, installationId: row.installation_id };
    },

    /** The channels that link a repository. Its name is brought up to date first, as GitHub names it now. */
    async githubChannelsFor(repoId: number, repo: string): Promise<number[]> {
      await sql.query('UPDATE webchat.project_repos SET repo = $2 WHERE repo_id = $1 AND repo <> $2', [repoId, repo]);
      return (
        await sql.query<{ conversation_id: number }>(
          'SELECT DISTINCT conversation_id FROM webchat.project_repos WHERE repo_id = $1',
          [repoId],
        )
      ).map((row) => row.conversation_id);
    },
    /** Forgets links and grants through an installation, or only for some of its repositories. */
    async dropGithubInstallation(installationId: number, repoIds: number[] | null = null) {
      for (const table of ['project_repos', 'github_app_grants']) {
        await sql.query(
          `DELETE FROM webchat.${table} WHERE installation_id = $1 AND ($2::bigint[] IS NULL OR repo_id = ANY($2::bigint[]))`,
          [installationId, repoIds],
        );
      }
    },
    /** True the first time a webhook delivery comes in. GitHub may send the same one again. */
    claimGithubDelivery: async (deliveryId: string) =>
      (
        await sql.query(
          'INSERT INTO webchat.github_deliveries (id, received_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
          [deliveryId, Date.now()],
        )
      ).length > 0,
    releaseGithubDelivery: async (deliveryId: string) => {
      await sql.query('DELETE FROM webchat.github_deliveries WHERE id = $1', [deliveryId]);
    },

    /**
     * Links a GitHub account, replacing any linked before. The first poll after this only records
     * the pull requests, so connecting never sends a burst of alerts.
     */
    saveGithubAccount(userId: number, account: { githubId: number; login: string; name: string | null; token: string }) {
      return sql.transaction(async (tx) => {
        const previous = await one(
          tx.query<{ github_id: number }>('SELECT github_id FROM webchat.github_accounts WHERE user_id = $1', [userId]),
        );
        if (previous && previous.github_id !== account.githubId) {
          await tx.query('DELETE FROM webchat.github_events WHERE user_id = $1', [userId]);
        }
        await tx.query(
          `INSERT INTO webchat.github_accounts (user_id, github_id, login, name, token, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE SET
             github_id = EXCLUDED.github_id, login = EXCLUDED.login, name = EXCLUDED.name, token = EXCLUDED.token,
             pulls = NULL, fetched_at = NULL, polled_at = 0, error = NULL, revoked = false`,
          [userId, account.githubId, account.login, account.name, account.token, Date.now()],
        );
      });
    },
    githubAccount: (userId: number) =>
      one(sql.query<GithubAccountRow>('SELECT * FROM webchat.github_accounts WHERE user_id = $1', [userId])),
    deleteGithubAccount: (userId: number) =>
      sql.transaction(async (tx) => {
        await tx.query('DELETE FROM webchat.github_events WHERE user_id = $1', [userId]);
        await tx.query('DELETE FROM webchat.github_accounts WHERE user_id = $1', [userId]);
      }),
    setGithubNotify: async (userId: number, notify: boolean) => {
      await sql.query('UPDATE webchat.github_accounts SET notify = $2 WHERE user_id = $1', [userId, notify]);
    },
    /**
     * Claims an account for one poll, unless it was polled less than minIntervalMs ago or GitHub
     * revoked its token. Returns undefined when there is nothing to do.
     */
    claimGithubPoll: (userId: number, minIntervalMs: number) => {
      const now = Date.now();
      return one(
        sql.query<GithubAccountRow>(
          `UPDATE webchat.github_accounts SET polled_at = $2
           WHERE user_id = $1 AND NOT revoked AND polled_at <= $3 RETURNING *`,
          [userId, now, now - minIntervalMs],
        ),
      );
    },
    githubAccountsDue: async (minIntervalMs: number) =>
      (
        await sql.query<{ user_id: number }>(
          'SELECT user_id FROM webchat.github_accounts WHERE NOT revoked AND polled_at <= $1 ORDER BY polled_at',
          [Date.now() - minIntervalMs],
        )
      ).map((row) => row.user_id),
    /** Records that pollAll started, so the pane can tell whether alerts arrive with every tab closed. */
    markGithubScheduledPoll: async () => {
      await sql.query(
        'INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [GITHUB_SCHEDULED_AT, String(Date.now())],
      );
    },
    /** When pollAll last started, or 0 if it never has. */
    githubScheduledPollAt: async () =>
      Number(
        (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [GITHUB_SCHEDULED_AT])))
          ?.value ?? 0,
      ),
    jobSecret: async () =>
      (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [JOB_SECRET])))?.value ??
      null,
    /**
     * Makes the database call url on the job's schedule with the job secret, through Supabase Cron:
     * pg_cron keeps the clock and pg_net sends the request. A job that already matches is left
     * alone, even one the owner deactivated, so every server start can call this cheaply. Throws
     * where the extensions are missing or the role may not enable them. Returns true when it
     * scheduled the job.
     */
    scheduleJob: (job: DatabaseJob, url: string) =>
      sql.transaction(async (tx) => {
        // Instances that start at the same moment would race to create the extensions.
        await tx.query('SELECT pg_advisory_xact_lock(7349202)');
        await tx.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
          JOB_SECRET,
          toBase64Url(randomBytes(32)),
        ]);
        // Reading the secret on every run keeps it out of the job's text, which Supabase's Cron page shows.
        const command =
          `SELECT net.http_get(url := ${sqlLiteral(url)}, headers := jsonb_build_object('authorization', ` +
          `'Bearer ' || (SELECT value FROM webchat.meta WHERE key = ${sqlLiteral(JOB_SECRET)})), ` +
          // pg_net gives up after 2 seconds by default; a poll of every due account takes longer.
          'timeout_milliseconds := 25000)' +
          (job.when ? ` WHERE ${job.when}` : '');
        const installed = await tx.query("SELECT 1 FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net')");
        if (installed.length === 2) {
          const current = await one(
            tx.query<{ schedule: string; command: string }>('SELECT schedule, command FROM cron.job WHERE jobname = $1', [
              job.name,
            ]),
          );
          if (current?.schedule === job.schedule && current.command === command) return false;
        }
        await tx.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
        // Supabase keeps extensions in their own schema. pg_net's functions still live in "net".
        await tx.query('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions');
        await tx.query('SELECT cron.schedule($1, $2, $3)', [job.name, job.schedule, command]);
        return true;
      }),
    saveGithubPulls: async (userId: number, login: string, pulls: string) => {
      await sql.query(
        'UPDATE webchat.github_accounts SET login = $2, pulls = $3, fetched_at = $4, error = NULL WHERE user_id = $1',
        [userId, login, pulls, Date.now()],
      );
    },
    setGithubError: async (userId: number, error: string, revoked: boolean) => {
      await sql.query('UPDATE webchat.github_accounts SET error = $2, revoked = $3 WHERE user_id = $1', [
        userId,
        error,
        revoked,
      ]);
    },
    /** Stores new events, drops the oldest beyond the ones kept, and returns the stored events. */
    addGithubEvents(userId: number, events: Array<Omit<GithubEventDTO, 'id' | 'createdAt'>>) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const added: GithubEventDTO[] = [];
        for (const e of events) {
          const row = await one(
            tx.query<GithubEventRow>(
              `INSERT INTO webchat.github_events (user_id, kind, repo, number, title, url, actor, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
              [userId, e.kind, e.repo, e.number, e.title, e.url, e.actor, now],
            ),
          );
          added.push(toGithubEventDTO(row!));
        }
        await tx.query(
          `DELETE FROM webchat.github_events WHERE user_id = $1 AND id NOT IN (
             SELECT id FROM webchat.github_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
          [userId, GITHUB_EVENTS_KEPT],
        );
        return added;
      });
    },
    githubEvents: async (userId: number) =>
      (
        await sql.query<GithubEventRow>('SELECT * FROM webchat.github_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [
          userId,
          GITHUB_EVENTS_KEPT,
        ])
      ).map(toGithubEventDTO),
  };
}
