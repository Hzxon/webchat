import type { Sql } from '../sql.js';
import { type BarkDeviceRow, type BarkLinkRow, one } from './rows.js';
import type { Helpers } from './helpers.js';

export function barkQueries(sql: Sql, _helpers: Helpers) {
  return {

    barkLinkFor: (userId: number) => one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE user_id = $1', [userId])),
    barkLinkByToken: (token: string) => one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE token = $1', [token])),
    /** Makes the person's link, or keeps the one they have. */
    createBarkLink: async (userId: number, token: string, origin: string): Promise<BarkLinkRow> => {
      await sql.query(
        `INSERT INTO webchat.bark_links (user_id, token, origin, cipher_key, created_at) VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, token, origin, Date.now()],
      );
      return (await one(sql.query<BarkLinkRow>('SELECT * FROM webchat.bark_links WHERE user_id = $1', [userId])))!;
    },
    setBarkCipherKey: async (userId: number, cipherKey: string | null) => {
      await sql.query('UPDATE webchat.bark_links SET cipher_key = $2 WHERE user_id = $1', [userId, cipherKey]);
    },
    deleteBarkLink: async (userId: number) => {
      await sql.query('DELETE FROM webchat.bark_devices WHERE user_id = $1', [userId]);
      await sql.query('DELETE FROM webchat.bark_links WHERE user_id = $1', [userId]);
    },
    /**
     * Records a Bark install. The app registers again on every launch, so the same phone, found by
     * its APNs token or by the key it was given, keeps its key. A phone that moves to another
     * account leaves the old one, so only one person's alerts reach it.
     */
    registerBarkDevice: async (userId: number, deviceToken: string, key: string | null, newKey: string): Promise<BarkDeviceRow> => {
      const now = Date.now();
      await sql.query('DELETE FROM webchat.bark_devices WHERE device_token = $1 AND user_id <> $2', [deviceToken, userId]);
      const existing = await one(
        sql.query<BarkDeviceRow>(
          'SELECT * FROM webchat.bark_devices WHERE user_id = $1 AND (device_token = $2 OR device_key = $3) ORDER BY created_at LIMIT 1',
          [userId, deviceToken, key ?? ''],
        ),
      );
      if (existing) {
        await sql.query('UPDATE webchat.bark_devices SET device_token = $2, seen_at = $3 WHERE device_key = $1', [
          existing.device_key,
          deviceToken,
          now,
        ]);
        return { ...existing, device_token: deviceToken, seen_at: now };
      }
      await sql.query(
        'INSERT INTO webchat.bark_devices (device_key, user_id, device_token, created_at, seen_at) VALUES ($1, $2, $3, $4, $5)',
        [newKey, userId, deviceToken, now, now],
      );
      return { device_key: newKey, user_id: userId, device_token: deviceToken, created_at: now, seen_at: now };
    },
    barkDevicesFor: (userId: number) =>
      sql.query<BarkDeviceRow>('SELECT * FROM webchat.bark_devices WHERE user_id = $1 ORDER BY created_at', [userId]),
    deleteBarkDevice: async (deviceKey: string) => {
      await sql.query('DELETE FROM webchat.bark_devices WHERE device_key = $1', [deviceKey]);
    },
  };
}
