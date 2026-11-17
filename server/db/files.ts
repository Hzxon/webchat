import { LIMITS } from '../../shared/types.js';
import type { Sql } from '../sql.js';
import { type FileRow, one } from './rows.js';
import type { Helpers } from './helpers.js';

export function filesQueries(sql: Sql, _helpers: Helpers) {
  return {

    // Photos and files (R-005, D-123). A row stands for ciphertext in the store.
    insertFile: async (id: string, conversationId: number, uploaderId: number, size: number) => {
      await sql.query('INSERT INTO webchat.files (id, conversation_id, uploader_id, size, created_at) VALUES ($1, $2, $3, $4, $5)', [
        id,
        conversationId,
        uploaderId,
        size,
        Date.now(),
      ]);
    },
    getFile: (id: string) => one(sql.query<FileRow>('SELECT * FROM webchat.files WHERE id = $1', [id])),
    /** Ties an upload to the message that names it. False when it is not this sender's in this chat, or is gone. */
    markFileSent: async (id: string, conversationId: number, uploaderId: number) =>
      (
        await sql.query('UPDATE webchat.files SET sent = true WHERE id = $1 AND conversation_id = $2 AND uploader_id = $3 RETURNING id', [
          id,
          conversationId,
          uploaderId,
        ])
      ).length > 0,
    /** The bytes stored, of everyone's files or of one uploader's. */
    storedFileBytes: async (uploaderId: number | null = null) =>
      Number(
        (await one(sql.query<{ total: string }>('SELECT COALESCE(SUM(size), 0) AS total FROM webchat.files WHERE $1::int IS NULL OR uploader_id = $1', [uploaderId])))!
          .total,
      ),
    /** Counts an upload under a key of `meta`, or answers false once that count reached the limit. */
    countUpload: async (key: string, limit: number) =>
      (
        await sql.query(
          `INSERT INTO webchat.meta (key, value) VALUES ($1, '1')
           ON CONFLICT (key) DO UPDATE SET value = (webchat.meta.value::int + 1)::text WHERE webchat.meta.value::int < $2
           RETURNING value`,
          [key, limit],
        )
      ).length > 0,
    /** Files whose ciphertext goes: past their days, an upload no message followed for an hour, or of a deleted chat or account. */
    sweepableFiles: async (now: number) =>
      (
        await sql.query<{ id: string }>(
          `SELECT f.id FROM webchat.files f JOIN webchat.users u ON u.id = f.uploader_id
           WHERE f.created_at < $1 OR (NOT f.sent AND f.created_at < $2) OR f.conversation_id IS NULL OR u.deleted_at IS NOT NULL`,
          [now - LIMITS.fileDays * 86_400_000, now - 3_600_000],
        )
      ).map((r) => r.id),
    deleteFiles: async (ids: string[]) => {
      await sql.query('DELETE FROM webchat.files WHERE id = ANY($1::text[])', [ids]);
    },
  };
}
