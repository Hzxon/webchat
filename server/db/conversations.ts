import { type ConversationType, type RotatedKeyInput, type WrappedKeyInput } from '../../shared/types.js';
import type { Sql } from '../sql.js';
import { type FirstKey, type LeaveRefusal, one, sameIds } from './rows.js';
import type { Helpers } from './helpers.js';

export function conversationsQueries(sql: Sql, { conversations, insertWrappedKeys, lockProject, chatMembers, canReplace, replaceKey, leaveChat }: Helpers) {
  return {

    findDirect: async (userA: number, userB: number) =>
      (
        await one(
          sql.query<{ id: number }>('SELECT id FROM webchat.conversations WHERE direct_key = $1', [
            `${Math.min(userA, userB)}:${Math.max(userA, userB)}`,
          ]),
        )
      )?.id,

    /** Takes the next chat id for a chat this user is about to create, so the copies of its first key can name it (D-111). */
    async reserveConversationId(userId: number): Promise<number> {
      const row = await one(
        sql.query<{ id: number }>(
          `INSERT INTO webchat.conversation_ids (id, user_id, created_at)
           VALUES (nextval(pg_get_serial_sequence('webchat.conversations', 'id')), $1, $2) RETURNING id`,
          [userId, Date.now()],
        ),
      );
      return row!.id;
    },

    /** Uses up an id reserveConversationId gave this user. False when it gave none, or it was used. */
    takeConversationId: async (conversationId: number, userId: number) =>
      (await one(
        sql.query('DELETE FROM webchat.conversation_ids WHERE id = $1 AND user_id = $2 RETURNING id', [conversationId, userId]),
      )) !== undefined,

    /**
     * Creates a chat with its members and its key, wrapped for each member. For a direct chat that
     * already exists, returns the existing id and ignores the new key.
     */
    createConversation(type: ConversationType, title: string | null, memberIds: number[], key: FirstKey): Promise<number> {
      const now = Date.now();
      const directKey = type === 'direct' ? `${Math.min(...memberIds)}:${Math.max(...memberIds)}` : null;
      return sql.transaction(async (tx) => {
        const created = await one(
          tx.query<{ id: number }>(
            `INSERT INTO webchat.conversations (id, type, title, direct_key, created_at, updated_at, key_id, created_by)
             OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $5, $6, $7) ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
            // Only a group has an owner: the person who made it, who also wraps its key.
            [key.conversationId, type, title, directKey, now, key.keyId, type === 'group' ? key.wrappedBy : null],
          ),
        );
        if (!created) {
          const existing = await one(
            tx.query<{ id: number }>('SELECT id FROM webchat.conversations WHERE direct_key = $1', [directKey]),
          );
          return existing!.id;
        }
        for (const userId of memberIds) {
          await tx.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [
            created.id,
            userId,
            now,
          ]);
        }
        await insertWrappedKeys(tx, created.id, key.wrappedBy, key.wrappedKeys);
        return created.id;
      });
    },

    /**
     * Gives a chat from before encryption its key. Only the first caller wins. 'stale' when the
     * caller left, or the copies do not cover exactly the members. A group without an owner becomes
     * the caller's, as migration 4 did for the groups keyed before it.
     */
    setConversationKey(
      conversationId: number,
      keyId: string,
      wrappedBy: number,
      wrappedKeys: WrappedKeyInput[],
    ): Promise<true | 'has_key' | 'stale'> {
      return sql.transaction(async (tx) => {
        // Adding, removing and leaving lock this row too, so the members stay as checked until the key is stored.
        const chat = await one(
          tx.query<{ key_id: string | null }>('SELECT key_id FROM webchat.conversations WHERE id = $1 FOR UPDATE', [
            conversationId,
          ]),
        );
        if (chat?.key_id !== null) return 'has_key';
        const memberIds = await chatMembers(tx, conversationId);
        if (!memberIds.includes(wrappedBy) || !sameIds(memberIds, wrappedKeys.map((k) => k.userId))) return 'stale';
        await tx.query(
          `UPDATE webchat.conversations
           SET key_id = $2, created_by = CASE WHEN type = 'group' THEN COALESCE(created_by, $3) ELSE created_by END
           WHERE id = $1`,
          [conversationId, keyId, wrappedBy],
        );
        await insertWrappedKeys(tx, conversationId, wrappedBy, wrappedKeys);
        return true;
      });
    },
    /** A chat's current key id, and whether someone who holds that key left. */
    conversationKey: async (conversationId: number) =>
      (await one(
        sql.query<{ key_id: string | null; needs_new_key: boolean }>(
          'SELECT key_id, needs_new_key FROM webchat.conversations WHERE id = $1',
          [conversationId],
        ),
      )) ?? { key_id: null, needs_new_key: false },

    conversationsFor: (userId: number) => conversations(userId, null),
    conversationFor: async (userId: number, conversationId: number) => (await conversations(userId, conversationId))[0],
    getConversation: (conversationId: number) =>
      one(
        sql.query<{ type: ConversationType; created_by: number | null; project_id: number | null }>(
          'SELECT type, created_by, project_id FROM webchat.conversations WHERE id = $1',
          [conversationId],
        ),
      ),

    /**
     * Adds people to a group. Its key, if it has one, must come wrapped for them by the member
     * adding them, so they can read its history. Their read pointers start at the newest message,
     * so that history does not count as unread. Stale when the key changed since the client looked,
     * or the member adding them was removed meanwhile.
     */
    addGroupMembers(
      conversationId: number,
      addedBy: number,
      userIds: number[],
      key: { keyId: string; wrappedKeys: WrappedKeyInput[] } | null,
    ): Promise<true | 'stale' | 'already_member'> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ key_id: string | null; last_message_id: number }>(
            'SELECT key_id, last_message_id FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = (
          await tx.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [
            conversationId,
          ])
        ).map((row) => row.user_id);
        if (!chat || !memberIds.includes(addedBy) || chat.key_id !== (key?.keyId ?? null)) return 'stale';
        if (userIds.some((id) => memberIds.includes(id))) return 'already_member';

        for (const userId of userIds) {
          await tx.query(
            `INSERT INTO webchat.members (conversation_id, user_id, joined_at, last_delivered_id, last_read_id)
             VALUES ($1, $2, $3, $4, $4)`,
            [conversationId, userId, now, chat.last_message_id],
          );
        }
        if (key) await insertWrappedKeys(tx, conversationId, addedBy, key.wrappedKeys);
        return true;
      });
    },

    /**
     * Removes someone from a group. A group with a key gets a new one from the member removing
     * them, wrapped for exactly the people who stay. Returns false when the group changed since the
     * client looked, such as that person being gone already.
     */
    removeGroupMember(
      conversationId: number,
      removedBy: number,
      userId: number,
      key: RotatedKeyInput | null,
    ): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ id: number; key_id: string | null }>(
            'SELECT id, key_id FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = await chatMembers(tx, conversationId);
        const staying = memberIds.filter((id) => id !== userId);
        if (!chat || staying.length === memberIds.length) return false;
        // A group from before encryption has no key to replace.
        if (chat.key_id === null ? key !== null : !(await canReplace(tx, chat, key ?? undefined, staying))) return false;

        await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
        if (key) await replaceKey(tx, conversationId, removedBy, key);
        return true;
      });
    },

    /** Takes someone out of a group at their own request. The owner must hand it over first. */
    leaveGroup(conversationId: number, userId: number): Promise<true | LeaveRefusal> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ type: ConversationType; created_by: number | null }>(
            'SELECT type, created_by FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const memberIds = await chatMembers(tx, conversationId);
        if (chat?.type !== 'group' || !memberIds.includes(userId)) return 'stale';
        if (chat.created_by === userId) return 'owner';
        if (memberIds.length === 1) return 'last_member';
        await leaveChat(tx, conversationId, userId);
        return true;
      });
    },

    /**
     * Makes another member the group's owner. False unless the caller still owns it, or it has no
     * owner yet, and the other person is in it.
     */
    handOverGroup(conversationId: number, ownerId: number, newOwnerId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const chat = await one(
          tx.query<{ type: ConversationType; created_by: number | null }>(
            'SELECT type, created_by FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        const owns = chat?.type === 'group' && (chat.created_by === null || chat.created_by === ownerId);
        if (!owns || !(await chatMembers(tx, conversationId)).includes(newOwnerId)) return false;
        await tx.query('UPDATE webchat.conversations SET created_by = $2 WHERE id = $1', [conversationId, newOwnerId]);
        return true;
      });
    },

    /**
     * Replaces a chat's key with a new key from a member: after someone left, or when the member's
     * copy is from before copies named their chat, which the server cannot tell (K-65). False when
     * its members or key changed since the client looked.
     */
    replaceConversationKey(conversationId: number, replacedBy: number, key: RotatedKeyInput): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const projectId =
          (
            await one(
              tx.query<{ project_id: number | null }>('SELECT project_id FROM webchat.conversations WHERE id = $1', [
                conversationId,
              ]),
            )
          )?.project_id ?? null;
        // A channel's members are its project's, so lock the project first, as every change to them does.
        if (projectId !== null) await lockProject(tx, projectId);
        const chat = await one(
          tx.query<{ id: number; key_id: string | null; needs_new_key: boolean }>(
            'SELECT id, key_id, needs_new_key FROM webchat.conversations WHERE id = $1 FOR UPDATE',
            [conversationId],
          ),
        );
        if (!chat || !(await canReplace(tx, chat, key, await chatMembers(tx, conversationId)))) return false;
        await replaceKey(tx, conversationId, replacedBy, key);
        return true;
      });
    },

    /** Deletes a chat for everyone, with its messages and keys. */
    deleteConversation: async (conversationId: number) => {
      await sql.query('DELETE FROM webchat.conversations WHERE id = $1', [conversationId]);
    },
    memberIds: (conversationId: number) => chatMembers(sql, conversationId),
    isMember: async (conversationId: number, userId: number) =>
      (
        await sql.query('SELECT 1 FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [
          conversationId,
          userId,
        ])
      ).length > 0,
  };
}
