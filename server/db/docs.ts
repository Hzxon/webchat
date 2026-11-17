import { LIMITS, type DocRevisionDTO, type EnvelopeDTO } from '../../shared/types.js';
import type { Sql } from '../sql.js';
import { DOC_LOCK_MS, type DocRevisionRow, type DocRow, one, toDocRevisionDTO } from './rows.js';
import type { Helpers } from './helpers.js';

export function docsQueries(sql: Sql, { docs }: Helpers) {
  return {

    docsFor: (userId: number) => docs(userId, null),
    docFor: async (userId: number, docId: string) => (await docs(userId, docId))[0],
    getDoc: (docId: string) => one(sql.query<DocRow>('SELECT * FROM webchat.docs WHERE id = $1', [docId])),

    /** Stores a new doc with its title and first sections. False when its id is taken. */
    createDoc(docId: string, conversationId: number, userId: number, revisions: Array<{ section: string; envelope: EnvelopeDTO }>) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const created = await tx.query(
          `INSERT INTO webchat.docs (id, conversation_id, created_by, created_at, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [docId, conversationId, userId, now],
        );
        if (created.length === 0) return false;
        for (const r of revisions) {
          await tx.query(
            `INSERT INTO webchat.doc_revisions (doc_id, section, author_id, envelope, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)`,
            [docId, r.section, userId, JSON.stringify(r.envelope), now],
          );
        }
        return true;
      });
    },

    /** The newest revision of each section of a doc, the title among them. */
    docSections: async (docId: string) =>
      (
        await sql.query<DocRevisionRow>(
          'SELECT DISTINCT ON (section) * FROM webchat.doc_revisions WHERE doc_id = $1 ORDER BY section, id DESC',
          [docId],
        )
      ).map(toDocRevisionDTO),

    /** Each section's oldest revision and each author's newest of it, in id order: a card's opener and its members' words. */
    docWords: async (docId: string) =>
      (
        await sql.query<DocRevisionRow>(
          `SELECT * FROM webchat.doc_revisions WHERE doc_id = $1 AND id IN (
             SELECT MAX(id) FROM webchat.doc_revisions WHERE doc_id = $1 GROUP BY section, author_id
             UNION SELECT MIN(id) FROM webchat.doc_revisions WHERE doc_id = $1 GROUP BY section) ORDER BY id`,
          [docId],
        )
      ).map(toDocRevisionDTO),

    /** A section's revisions, newest first. */
    sectionHistory: async (docId: string, section: string) =>
      (
        await sql.query<DocRevisionRow>(
          `SELECT * FROM webchat.doc_revisions WHERE doc_id = $1 AND section = $2 ORDER BY id DESC LIMIT ${LIMITS.docHistory}`,
          [docId, section],
        )
      ).map(toDocRevisionDTO),

    /**
     * Locks a section for this user, or keeps the lock they hold, and returns who holds it now: this
     * user, or someone else whose lock has not run out.
     */
    lockSection: async (docId: string, section: string, userId: number) => {
      const now = Date.now();
      const row = await one(
        sql.query<{ user_id: number }>(
          `WITH claimed AS (
             INSERT INTO webchat.doc_locks AS l (doc_id, section, user_id, expires_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (doc_id, section) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at,
               revision_id = CASE WHEN l.user_id = EXCLUDED.user_id THEN l.revision_id END
             WHERE l.user_id = EXCLUDED.user_id OR l.expires_at <= $5
             RETURNING user_id
           )
           SELECT user_id FROM claimed
           UNION ALL
           SELECT user_id FROM webchat.doc_locks WHERE doc_id = $1 AND section = $2 AND NOT EXISTS (SELECT 1 FROM claimed)`,
          [docId, section, userId, now + DOC_LOCK_MS, now],
        ),
      );
      return row?.user_id;
    },
    unlockSection: async (docId: string, section: string, userId: number) => {
      await sql.query('DELETE FROM webchat.doc_locks WHERE doc_id = $1 AND section = $2 AND user_id = $3', [docId, section, userId]);
    },
    /** Keeps the lock of the section a tab is editing, while its user is still in the doc's chat. */
    renewSectionLock: async (userId: number, docId: string, section: string) => {
      await sql.query(
        `UPDATE webchat.doc_locks l SET expires_at = $4
         WHERE l.doc_id = $1 AND l.section = $2 AND l.user_id = $3
           AND EXISTS (SELECT 1 FROM webchat.docs d JOIN webchat.members m ON m.conversation_id = d.conversation_id
                       WHERE d.id = l.doc_id AND m.user_id = l.user_id)`,
        [docId, section, userId, Date.now() + DOC_LOCK_MS],
      );
    },

    /**
     * Saves a section for the holder of its lock. The editing session's first save adds a revision,
     * and later ones replace it, so the history keeps one revision per session. Null without the lock.
     */
    saveSection(docId: string, section: string, userId: number, envelope: EnvelopeDTO) {
      return sql.transaction(async (tx): Promise<DocRevisionDTO | null> => {
        const now = Date.now();
        const lock = await one(
          tx.query<{ revision_id: number | null }>(
            `SELECT revision_id FROM webchat.doc_locks
             WHERE doc_id = $1 AND section = $2 AND user_id = $3 AND expires_at > $4 FOR UPDATE`,
            [docId, section, userId, now],
          ),
        );
        if (!lock) return null;
        const json = JSON.stringify(envelope);
        const row = (await one(
          lock.revision_id
            ? tx.query<DocRevisionRow>('UPDATE webchat.doc_revisions SET envelope = $1, updated_at = $2 WHERE id = $3 RETURNING *', [
                json,
                now,
                lock.revision_id,
              ])
            : tx.query<DocRevisionRow>(
                `INSERT INTO webchat.doc_revisions (doc_id, section, author_id, envelope, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
                [docId, section, userId, json, now],
              ),
        ))!;
        await tx.query('UPDATE webchat.doc_locks SET revision_id = $1, expires_at = $2 WHERE doc_id = $3 AND section = $4', [
          row.id,
          now + DOC_LOCK_MS,
          docId,
          section,
        ]);
        await tx.query('UPDATE webchat.docs SET version = version + 1, updated_by = $1, updated_at = $2 WHERE id = $3', [
          userId,
          now,
          docId,
        ]);
        return toDocRevisionDTO(row);
      });
    },
    deleteDoc: async (docId: string) => {
      await sql.query('DELETE FROM webchat.docs WHERE id = $1', [docId]);
    },
  };
}
