import type { Sql } from '../sql.js';
import { type PushSubscriptionRow } from './rows.js';
import type { Helpers } from './helpers.js';

export function pushQueries(sql: Sql, _helpers: Helpers) {
  return {

    /** Saves the subscription; false when another account holds the endpoint under other keys. */
    savePushSubscription: async (userId: number, endpoint: string, p256dh: string, auth: string) => {
      const saved = await sql.query(
        `INSERT INTO webchat.push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
         -- Another account takes an endpoint only with its keys, as the same browser signed in to it
         -- sends them; the endpoint alone would let anyone who learned it take someone's pushes.
         WHERE push_subscriptions.user_id = EXCLUDED.user_id
            OR (push_subscriptions.p256dh = EXCLUDED.p256dh AND push_subscriptions.auth = EXCLUDED.auth)
         RETURNING endpoint`,
        [endpoint, userId, p256dh, auth, Date.now()],
      );
      return saved.length > 0;
    },
    deletePushSubscription: async (endpoint: string) => {
      await sql.query('DELETE FROM webchat.push_subscriptions WHERE endpoint = $1', [endpoint]);
    },
    deleteUserPushSubscription: async (endpoint: string, userId: number) => {
      await sql.query('DELETE FROM webchat.push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
    },
    pushSubscriptionsFor: (userId: number) =>
      sql.query<PushSubscriptionRow>(
        'SELECT endpoint, user_id, p256dh, auth FROM webchat.push_subscriptions WHERE user_id = $1',
        [userId],
      ),
  };
}
