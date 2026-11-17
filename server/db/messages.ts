import { type EnvelopeDTO, type MessageDTO, type MessageKind } from '../../shared/types.js';
import type { Sql } from '../sql.js';
import { AGENT_ONLINE_WINDOW_MS, type MessageRow, ONLINE_WINDOW_MS, SYNC_OVERLAP_MS, SYNC_PAGE_SIZE, one, toMessageDTO, unreadUrgentFrom } from './rows.js';
import type { Helpers } from './helpers.js';

export function messagesQueries(sql: Sql, { markRead }: Helpers) {
  return {

    /**
     * Stores an encrypted message, moves the chat to the top, and marks it read for its sender. A
     * reaction only bumps the chat's newest event, so it neither reorders chats nor counts as unread.
     * A client id the sender used before in this chat is the same send again, after its answer was
     * lost: nothing changes, and `repeated` says so (D-061).
     */
    insertMessage(
      conversationId: number,
      senderId: number,
      kind: Exclude<MessageKind, 'github'>,
      envelope: EnvelopeDTO,
      urgent: boolean,
      clientId: string,
    ) {
      return sql.transaction(async (tx): Promise<{ message: MessageDTO; repeated: boolean }> => {
        const now = Date.now();
        const row = await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, kind, body, envelope, urgent, client_id, created_at)
             VALUES ($1, $2, $3, '', $4, $5, $6, $7)
             ON CONFLICT (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`,
            [conversationId, senderId, kind, JSON.stringify(envelope), urgent, clientId, now],
          ),
        );
        if (!row) {
          const stored = (await one(
            tx.query<MessageRow>('SELECT * FROM webchat.messages WHERE conversation_id = $1 AND sender_id = $2 AND client_id = $3', [
              conversationId,
              senderId,
              clientId,
            ]),
          ))!;
          return { message: toMessageDTO(stored), repeated: true };
        }
        if (kind === 'message') {
          await tx.query(
            `UPDATE webchat.conversations
             SET last_message_id = GREATEST(last_message_id, $1), last_event_id = GREATEST(last_event_id, $1), updated_at = $2
             WHERE id = $3`,
            [row.id, now, conversationId],
          );
          await markRead(tx, conversationId, senderId, row.id);
        } else {
          await tx.query('UPDATE webchat.conversations SET last_event_id = GREATEST(last_event_id, $1) WHERE id = $2', [
            row.id,
            conversationId,
          ]);
        }
        return { message: toMessageDTO(row), repeated: false };
      });
    },
    /** Stores a card from GitHub, as plain JSON with no sender, and moves the chat to the top like a message. */
    insertGithubCard(conversationId: number, card: string) {
      return sql.transaction(async (tx) => {
        const now = Date.now();
        const row = (await one(
          tx.query<MessageRow>(
            `INSERT INTO webchat.messages (conversation_id, sender_id, kind, body, envelope, urgent, client_id, created_at)
             VALUES ($1, NULL, 'github', $2, NULL, false, NULL, $3) RETURNING *`,
            [conversationId, card, now],
          ),
        ))!;
        await tx.query(
          `UPDATE webchat.conversations
           SET last_message_id = GREATEST(last_message_id, $1), last_event_id = GREATEST(last_event_id, $1), updated_at = $2
           WHERE id = $3`,
          [row.id, now, conversationId],
        );
        return toMessageDTO(row);
      });
    },
    messagesBefore: async (conversationId: number, beforeId: number, limit: number) =>
      (
        await sql.query<MessageRow>(
          'SELECT * FROM webchat.messages WHERE conversation_id = $1 AND id < $2::bigint ORDER BY id DESC LIMIT $3',
          [conversationId, beforeId, limit],
        )
      )
        .reverse()
        .map(toMessageDTO),

    /** Moves the read pointer forward, never past the newest message. */
    async markRead(conversationId: number, userId: number, messageId: number) {
      const newest = await one(
        sql.query<{ last_message_id: number }>('SELECT last_message_id FROM webchat.conversations WHERE id = $1', [
          conversationId,
        ]),
      );
      return markRead(sql, conversationId, userId, Math.min(messageId, newest?.last_message_id ?? 0));
    },

    /**
     * Marks messages from others as delivered to this user, per chat, up to the given ids but never
     * past the chat's newest event. The service worker sends these ids, so a client could send any.
     */
    async markDelivered(userId: number, upTo: Map<number, number>) {
      for (const [conversationId, messageId] of upTo) {
        await sql.query(
          `UPDATE webchat.members m SET last_delivered_id = LEAST($1, c.last_event_id)
           FROM webchat.conversations c
           WHERE c.id = m.conversation_id AND m.conversation_id = $2 AND m.user_id = $3
             AND m.last_delivered_id < LEAST($1, c.last_event_id)`,
          [messageId, conversationId, userId],
        );
      }
    },

    /** Mutes or unmutes a chat for one member only. */
    setMuted: async (conversationId: number, userId: number, muted: boolean) => {
      await sql.query('UPDATE webchat.members SET muted = $1 WHERE conversation_id = $2 AND user_id = $3', [muted, conversationId, userId]);
    },

    /** Unread messages in the chats this user has not muted, for the app badge a push sets. */
    unreadTotal: async (userId: number) =>
      (
        await one(
          sql.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total FROM webchat.messages x
             JOIN webchat.members m ON m.conversation_id = x.conversation_id
             WHERE m.user_id = $1 AND NOT m.muted AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM $1 AND x.kind NOT IN ('reaction', 'sync')`,
            [userId],
          ),
        )
      )?.total ?? 0,

    /**
     * One cheap query that changes whenever anything this user sees changes: a new message or
     * reaction, a read or delivered pointer, a new or deleted chat, channel or project, someone
     * joining or leaving one of them, a new key, a new owner, a new person, someone coming online
     * or going offline, a doc saved, added or deleted, or a doc section locked or freed.
     */
    async stamp(userId: number): Promise<string> {
      const row = await one(
        sql.query<{
          messages: number;
          pointers: number;
          chats: number;
          seats: number;
          keyed: number;
          rekeyed: number;
          owners: string;
          people: number;
          withKeys: number;
          online: string | null;
          agents: string | null;
          repos: string | null;
          docs: string;
          locks: string;
          muted: string;
        }>(
          `WITH mine AS (SELECT conversation_id, muted FROM webchat.members WHERE user_id = $1)
           SELECT
             (SELECT COALESCE(SUM(last_event_id), 0) FROM webchat.conversations WHERE id IN (SELECT conversation_id FROM mine)) AS messages,
             (SELECT COUNT(*)::int FROM webchat.conversations
               WHERE id IN (SELECT conversation_id FROM mine) AND key_id IS NOT NULL) AS keyed,
             (SELECT COUNT(*)::int FROM webchat.users WHERE dh_public IS NOT NULL) AS "withKeys",
             -- BIGINT, so two INTEGER pointers near the top of their range cannot overflow the sum.
             (SELECT COALESCE(SUM(last_read_id::bigint + last_delivered_id), 0) FROM webchat.members
               WHERE conversation_id IN (SELECT conversation_id FROM mine)) AS pointers,
             (SELECT COUNT(*)::int FROM mine) AS chats,
             -- Join times rather than a count, so one person leaving and another joining between
             -- two check-ins still changes it.
             (SELECT COALESCE(SUM(joined_at), 0)::bigint FROM webchat.members
               WHERE conversation_id IN (SELECT conversation_id FROM mine)) AS seats,
             -- Links are only ever added, one per new key, so their times change with every rotation.
             (SELECT COALESCE(SUM(created_at), 0)::bigint FROM webchat.key_links
               WHERE conversation_id IN (SELECT conversation_id FROM mine)) AS rekeyed,
             -- A hash of who owns each project and group, so a handover always shows, even two at once.
             (SELECT md5(COALESCE(string_agg(pair, ',' ORDER BY pair), '')) FROM (
               SELECT 'c' || id || ':' || created_by AS pair FROM webchat.conversations
                 WHERE id IN (SELECT conversation_id FROM mine) AND created_by IS NOT NULL
               UNION ALL
               SELECT 'p' || p.id || ':' || p.created_by FROM webchat.projects p
                 JOIN webchat.project_members pm ON pm.project_id = p.id WHERE pm.user_id = $1
             ) owned) AS owners,
             (SELECT COUNT(*)::int FROM webchat.users) AS people,
             (SELECT string_agg(id::text, ',' ORDER BY id) FROM webchat.users
               WHERE last_active_at > CASE WHEN agent_owner IS NULL THEN $2::bigint ELSE $4::bigint END) AS online,
             -- Agents with their owners, so the board offers each owner theirs (K-45), and what their laptops can do (R-036).
             (SELECT md5(string_agg(id || ':' || agent_owner || ':' || protocol, ',' ORDER BY id)) FROM webchat.users WHERE agent_owner IS NOT NULL) AS agents,
             -- Each agent's sessions by repository: which exist, which are online, and what they can do (D-094, D-103).
             (SELECT md5(string_agg(user_id || ':' || repo || ':' || protocol || ':' || (last_seen > $4), ',' ORDER BY user_id, repo))
               FROM webchat.agent_repos) AS repos,
             -- Every save grows a doc's version, and a doc deleted leaves the list.
             (SELECT md5(COALESCE(string_agg(id || ':' || version, ',' ORDER BY id), '')) FROM webchat.docs
               WHERE conversation_id IN (SELECT conversation_id FROM mine)) AS docs,
             -- Who edits which section, while the lock lasts.
             (SELECT md5(COALESCE(string_agg(l.doc_id || ':' || l.section || ':' || l.user_id, ',' ORDER BY l.doc_id, l.section), ''))
               FROM webchat.doc_locks l JOIN webchat.docs d ON d.id = l.doc_id
               WHERE d.conversation_id IN (SELECT conversation_id FROM mine) AND l.expires_at > $3) AS locks,
             -- Which chats this user muted, so another device of theirs follows.
             (SELECT md5(COALESCE(string_agg(conversation_id::text, ',' ORDER BY conversation_id), '')) FROM mine WHERE muted) AS muted`,
          [userId, Date.now() - ONLINE_WINDOW_MS, Date.now(), Date.now() - AGENT_ONLINE_WINDOW_MS],
        ),
      );
      return row
        ? `${row.messages}.${row.pointers}.${row.chats}.${row.seats}.${row.keyed}.${row.rekeyed}.${row.owners}.${row.people}.${row.withKeys}.${row.online ?? ''}.${row.agents ?? ''}.${row.repos ?? ''}.${row.docs}.${row.locks}.${row.muted}`
        : '';
    },

    /**
     * Messages in the user's chats after the cursor, plus recent ones as an overlap, at most
     * SYNC_PAGE_SIZE. Rows after the cursor come first, so a busy overlap never crowds them out.
     */
    messagesSince: async (userId: number, cursor: number) =>
      (
        await sql.query<MessageRow>(
          `SELECT msg.* FROM webchat.messages msg
           JOIN webchat.members m ON m.conversation_id = msg.conversation_id AND m.user_id = $1
           WHERE msg.id > $2::bigint OR msg.created_at > $3
           ORDER BY msg.id > $2::bigint DESC, msg.id LIMIT ${SYNC_PAGE_SIZE}`,
          [userId, cursor, Date.now() - SYNC_OVERLAP_MS],
        )
      )
        .sort((a, b) => a.id - b.id)
        .map(toMessageDTO),

    /** Each chat's newest urgent message from someone else above the user's read pointer (D-078). */
    unreadUrgent: async (userId: number) =>
      (
        await sql.query<MessageRow>(
          `SELECT DISTINCT ON (msg.conversation_id) msg.* FROM ${unreadUrgentFrom('$2::bigint')} AND m.user_id = $1
           ORDER BY msg.conversation_id, msg.id DESC`,
          [userId, Date.now()],
        )
      )
        .sort((a, b) => a.id - b.id)
        .map(toMessageDTO),

    /** For every member, the newest urgent message of each chat they have not read: what rings again (D-079). */
    urgentRings: async () =>
      (
        await sql.query<MessageRow & { recipient_id: number }>(
          `SELECT DISTINCT ON (m.user_id, msg.conversation_id) m.user_id AS recipient_id, msg.*
           FROM ${unreadUrgentFrom('$1::bigint')}
           ORDER BY m.user_id, msg.conversation_id, msg.id DESC`,
          [Date.now()],
        )
      ).map((row) => ({ recipientId: row.recipient_id, message: toMessageDTO(row) })),

    latestMessageId: async (userId: number) =>
      (
        await one(
          sql.query<{ id: number }>(
            `SELECT COALESCE(MAX(c.last_event_id), 0) AS id FROM webchat.conversations c
             JOIN webchat.members m ON m.conversation_id = c.id WHERE m.user_id = $1`,
            [userId],
          ),
        )
      )?.id ?? 0,
  };
}
