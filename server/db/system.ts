import type { Sql } from '../sql.js';
import { AGENT_REPO_TTL_MS, CONVERSATION_ID_TTL_MS, DELIVERY_TTL_MS, one } from './rows.js';
import type { Helpers } from './helpers.js';

export function systemQueries(sql: Sql, _helpers: Helpers) {
  return {
    close: () => sql.close(),

    /**
     * Stores the value unless the key already has one, and returns whichever value won. Server
     * instances that start at the same moment all end up with the same value.
     */
    async claimMeta(key: string, value: string): Promise<string> {
      await sql.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
      const row = await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [key]));
      return row!.value;
    },
    getMeta: async (key: string): Promise<string | null> =>
      (await one(sql.query<{ value: string }>('SELECT value FROM webchat.meta WHERE key = $1', [key])))?.value ?? null,

    /**
     * Replaces a value only while it still is what the caller last read (null: nothing stored yet).
     * False means another instance changed it first, and the caller should read that instead.
     */
    setMetaIf: async (key: string, expected: string | null, value: string): Promise<boolean> => {
      const rows =
        expected === null
          ? await sql.query('INSERT INTO webchat.meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [
              key,
              value,
            ])
          : await sql.query('UPDATE webchat.meta SET value = $3 WHERE key = $1 AND value = $2 RETURNING key', [key, expected, value]);
      return rows.length > 0;
    },

    /** Counts one hit in a fixed window. Returns false once the key is over its limit. */
    async takeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
      const now = Date.now();
      const row = await one(
        sql.query<{ count: number }>(
          `INSERT INTO webchat.rate_limits AS r (key, window_start, count) VALUES ($1, $2, 1)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN r.window_start <= $3 THEN 1 ELSE r.count + 1 END,
             window_start = CASE WHEN r.window_start <= $3 THEN $2 ELSE r.window_start END
           RETURNING count`,
          [key, now, now - windowMs],
        ),
      );
      return (row?.count ?? 0) <= limit;
    },
    /** Takes back one hit, for an attempt that should not count. */
    returnRateLimit: async (key: string) => {
      await sql.query('UPDATE webchat.rate_limits SET count = count - 1 WHERE key = $1 AND count > 0', [key]);
    },
    purgeExpired: async () => {
      const now = Date.now();
      await sql.query('DELETE FROM webchat.sessions WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.rate_limits WHERE window_start <= $1', [now - 24 * 3600_000]);
      await sql.query('DELETE FROM webchat.github_app_grants WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.github_deliveries WHERE received_at <= $1', [now - DELIVERY_TTL_MS]);
      await sql.query('DELETE FROM webchat.pairings WHERE expires_at <= $1', [now]);
      await sql.query('DELETE FROM webchat.agent_repos WHERE last_seen <= $1', [now - AGENT_REPO_TTL_MS]);
      await sql.query('DELETE FROM webchat.conversation_ids WHERE created_at <= $1', [now - CONVERSATION_ID_TTL_MS]);
    },
  };
}
