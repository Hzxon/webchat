import { type ConversationDTO, type ConversationType, type DocDTO, type KeyLinkDTO, type MemberState, type ProjectDTO, type RotatedKeyInput, type WrappedKeyInput } from '../../shared/types.js';
import type { Querier, Sql } from '../sql.js';
import { type ConversationRow, type DocRevisionRow, type DocRow, type FirstKey, type KeyLinkRow, type MemberRow, type MessageRow, type ProjectRow, one, sameIds, toDocRevisionDTO, toMemberState, toMessageDTO } from './rows.js';

/** The queries that more than one resource's methods share, built over one connection. */
export function createHelpers(sql: Sql) {
  async function conversations(userId: number, onlyId: number | null): Promise<ConversationDTO[]> {
    const [rows, members, lastMessages, links] = await Promise.all([
      sql.query<ConversationRow>(
        `SELECT c.id, c.type, c.title, c.project_id, c.created_by, c.updated_at, c.key_id, c.needs_new_key, m.muted,
           k.wrapped_by AS my_wrapped_by, k.iv AS my_iv, k.wrapped AS my_wrapped,
           (SELECT COUNT(*)::int FROM webchat.messages x
             WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id IS DISTINCT FROM m.user_id
               AND x.kind NOT IN ('reaction', 'sync', 'events')) AS unread
         FROM webchat.conversations c JOIN webchat.members m ON m.conversation_id = c.id
         LEFT JOIN webchat.conversation_keys k ON k.conversation_id = c.id AND k.user_id = m.user_id
         WHERE m.user_id = $1 AND ($2::int IS NULL OR c.id = $2)
         ORDER BY c.updated_at DESC, c.id DESC`,
        [userId, onlyId],
      ),
      sql.query<MemberRow>(
        `SELECT mm.conversation_id, mm.user_id, mm.last_delivered_id, mm.last_read_id
         FROM webchat.members mm
         WHERE mm.conversation_id IN (
           SELECT conversation_id FROM webchat.members WHERE user_id = $1 AND ($2::int IS NULL OR conversation_id = $2))
         ORDER BY mm.joined_at, mm.user_id`,
        [userId, onlyId],
      ),
      sql.query<MessageRow>(
        `SELECT msg.* FROM webchat.messages msg
         JOIN webchat.conversations c ON c.last_message_id = msg.id
         JOIN webchat.members m ON m.conversation_id = c.id
         WHERE m.user_id = $1 AND ($2::int IS NULL OR c.id = $2)`,
        [userId, onlyId],
      ),
      sql.query<KeyLinkRow>(
        `SELECT l.conversation_id, l.key_id, l.previous_key_id, l.iv, l.wrapped FROM webchat.key_links l
         WHERE l.conversation_id IN (
           SELECT conversation_id FROM webchat.members WHERE user_id = $1 AND ($2::int IS NULL OR conversation_id = $2))
         ORDER BY l.created_at`,
        [userId, onlyId],
      ),
    ]);
    const membersByChat = new Map<number, MemberState[]>();
    for (const row of members) {
      const list = membersByChat.get(row.conversation_id) ?? [];
      list.push(toMemberState(row));
      membersByChat.set(row.conversation_id, list);
    }
    const linksByChat = new Map<number, KeyLinkDTO[]>();
    for (const row of links) {
      const list = linksByChat.get(row.conversation_id) ?? [];
      list.push({ keyId: row.key_id, previousKeyId: row.previous_key_id, iv: row.iv, data: row.wrapped });
      linksByChat.set(row.conversation_id, list);
    }
    const lastByChat = new Map(lastMessages.map((row) => [row.conversation_id, toMessageDTO(row)]));
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      projectId: row.project_id,
      ownerId: row.created_by,
      members: membersByChat.get(row.id) ?? [],
      lastMessage: lastByChat.get(row.id) ?? null,
      unread: row.unread,
      updatedAt: row.updated_at,
      keyId: row.key_id,
      myKey:
        row.my_wrapped_by !== null && row.my_iv && row.my_wrapped
          ? { wrappedBy: row.my_wrapped_by, iv: row.my_iv, data: row.my_wrapped }
          : null,
      keyLinks: linksByChat.get(row.id) ?? [],
      needsNewKey: row.needs_new_key,
      muted: row.muted,
    }));
  }


  async function markRead(q: Querier, conversationId: number, userId: number, messageId: number) {
    const row = await one(
      q.query<MemberRow>(
        `UPDATE webchat.members
         SET last_read_id = GREATEST(last_read_id, $1), last_delivered_id = GREATEST(last_delivered_id, $1)
         WHERE conversation_id = $2 AND user_id = $3 AND (last_read_id < $1 OR last_delivered_id < $1)
         RETURNING conversation_id, user_id, last_delivered_id, last_read_id`,
        [messageId, conversationId, userId],
      ),
    );
    return row && toMemberState(row);
  }


  async function insertWrappedKeys(q: Querier, conversationId: number, wrappedBy: number, wrappedKeys: WrappedKeyInput[]) {
    for (const k of wrappedKeys) {
      await q.query(
        `INSERT INTO webchat.conversation_keys (conversation_id, user_id, wrapped_by, iv, wrapped)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, k.userId, wrappedBy, k.iv, k.data],
      );
    }
  }


  async function projects(userId: number, onlyId: number | null): Promise<ProjectDTO[]> {
    const [rows, members] = await Promise.all([
      sql.query<ProjectRow>(
        `SELECT p.* FROM webchat.projects p JOIN webchat.project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = $1 AND ($2::int IS NULL OR p.id = $2)
         ORDER BY lower(p.name), p.id`,
        [userId, onlyId],
      ),
      sql.query<{ project_id: number; user_id: number }>(
        `SELECT pm.project_id, pm.user_id FROM webchat.project_members pm
         WHERE pm.project_id IN (
           SELECT project_id FROM webchat.project_members WHERE user_id = $1 AND ($2::int IS NULL OR project_id = $2))
         ORDER BY pm.joined_at, pm.user_id`,
        [userId, onlyId],
      ),
    ]);
    const membersOf = new Map<number, number[]>();
    for (const row of members) membersOf.set(row.project_id, [...(membersOf.get(row.project_id) ?? []), row.user_id]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.created_by,
      createdAt: row.created_at,
      memberIds: membersOf.get(row.id) ?? [],
    }));
  }


  /** Inserts a channel with its members and key. Returns undefined if the project has a channel of that name. */
  async function insertChannel(
    q: Querier,
    projectId: number,
    title: string,
    memberIds: number[],
    key: FirstKey,
  ) {
    const now = Date.now();
    const created = await one(
      q.query<{ id: number }>(
        `INSERT INTO webchat.conversations (id, type, title, project_id, created_at, updated_at, key_id)
         OVERRIDING SYSTEM VALUE VALUES ($1, 'channel', $2, $3, $4, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
        [key.conversationId, title, projectId, now, key.keyId],
      ),
    );
    if (!created) return undefined;
    for (const userId of memberIds) {
      await q.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [
        created.id,
        userId,
        now,
      ]);
    }
    await insertWrappedKeys(q, created.id, key.wrappedBy, key.wrappedKeys);
    return created.id;
  }


  /** Locks a project for a change to its members, owner or channels, and returns who is in it and who owns it. */
  async function lockProject(q: Querier, projectId: number) {
    const project = await one(
      q.query<{ created_by: number }>('SELECT created_by FROM webchat.projects WHERE id = $1 FOR UPDATE', [projectId]),
    );
    const memberIds = (
      await q.query<{ user_id: number }>('SELECT user_id FROM webchat.project_members WHERE project_id = $1', [projectId])
    ).map((row) => row.user_id);
    return { ownerId: project?.created_by ?? null, memberIds };
  }


  const chatMembers = async (q: Querier, conversationId: number) =>
    (
      await q.query<{ user_id: number }>('SELECT user_id FROM webchat.members WHERE conversation_id = $1', [conversationId])
    ).map((row) => row.user_id);


  const projectChannels = (q: Querier, projectId: number) =>
    q.query<{ id: number; key_id: string | null }>('SELECT id, key_id FROM webchat.conversations WHERE project_id = $1', [
      projectId,
    ]);


  /**
   * Whether a new key may replace a chat's current one: it names the current key as the one it
   * replaces, is wrapped for exactly these people, and has an id the chat never used, so the chain
   * of earlier keys has one way back.
   */
  async function canReplace(
    q: Querier,
    chat: { id: number; key_id: string | null },
    key: RotatedKeyInput | undefined,
    memberIds: number[],
  ) {
    if (!key || chat.key_id === null || key.link.previousKeyId !== chat.key_id || key.keyId === chat.key_id) return false;
    if (!sameIds(memberIds, key.wrappedKeys.map((k) => k.userId))) return false;
    const used = await q.query('SELECT 1 FROM webchat.key_links WHERE conversation_id = $1 AND previous_key_id = $2', [
      chat.id,
      key.keyId,
    ]);
    return used.length === 0;
  }


  /** Puts a new key in place of a chat's current one: a copy for every member, and the old key inside it. */
  async function replaceKey(q: Querier, conversationId: number, wrappedBy: number, key: RotatedKeyInput) {
    await q.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1', [conversationId]);
    await insertWrappedKeys(q, conversationId, wrappedBy, key.wrappedKeys);
    await q.query(
      `INSERT INTO webchat.key_links (conversation_id, key_id, previous_key_id, iv, wrapped, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conversationId, key.keyId, key.link.previousKeyId, key.link.iv, key.link.data, Date.now()],
    );
    await q.query('UPDATE webchat.conversations SET key_id = $2, needs_new_key = false WHERE id = $1', [
      conversationId,
      key.keyId,
    ]);
  }


  /**
   * Takes someone out of a chat at their own request. They hold its key and cannot make a new one
   * for the others, so the chat waits for a member who stays to replace it.
   */
  /** Docs in the chats this user is in, or only one of them, with each title and the locks held now (R-020). */
  async function docs(userId: number, onlyId: string | null): Promise<DocDTO[]> {
    const mine = `JOIN webchat.members m ON m.conversation_id = d.conversation_id AND m.user_id = $1
      WHERE ($2::text IS NULL OR d.id = $2)`;
    const [rows, titles, locks] = await Promise.all([
      sql.query<DocRow>(`SELECT d.* FROM webchat.docs d ${mine} ORDER BY d.created_at, d.id`, [userId, onlyId]),
      sql.query<DocRevisionRow>(
        `SELECT DISTINCT ON (r.doc_id) r.* FROM webchat.doc_revisions r JOIN webchat.docs d ON d.id = r.doc_id ${mine}
           AND r.section = 'title' ORDER BY r.doc_id, r.id DESC`,
        [userId, onlyId],
      ),
      sql.query<{ doc_id: string; section: string; user_id: number }>(
        `SELECT l.doc_id, l.section, l.user_id FROM webchat.doc_locks l JOIN webchat.docs d ON d.id = l.doc_id ${mine}
           AND l.expires_at > $3`,
        [userId, onlyId, Date.now()],
      ),
    ]);
    const titleOf = new Map(titles.map((r) => [r.doc_id, toDocRevisionDTO(r)]));
    return rows.map((d) => ({
      id: d.id,
      conversationId: d.conversation_id,
      createdBy: d.created_by,
      createdAt: d.created_at,
      version: d.version,
      updatedBy: d.updated_by,
      updatedAt: d.updated_at,
      title: titleOf.get(d.id) ?? null,
      locks: locks.filter((l) => l.doc_id === d.id).map((l) => ({ section: l.section, userId: l.user_id })),
    }));
  }


  /**
   * Deletes one account (R-028, D-088). The row stays, without its name, secrets or keys, so old
   * messages keep their sender. The person leaves every group and channel the way leaving does,
   * so each needs a new key before anyone sends again. Groups with nobody else, and direct chats,
   * which have nobody left to name them, are deleted. False when the person still owns a project
   * or group with other people in it: they hand it over or delete it first, as for leaving.
   * A new table with rows per user needs a line in the list below, since the row is never deleted.
   */
  async function removeAccount(tx: Querier, userId: number): Promise<boolean> {
    const projects = [];
    for (const { project_id } of await tx.query<{ project_id: number }>(
      'SELECT project_id FROM webchat.project_members WHERE user_id = $1 ORDER BY project_id',
      [userId],
    )) {
      projects.push({ id: project_id, ...(await lockProject(tx, project_id)) });
    }
    const chats = await tx.query<{ id: number; type: ConversationType; created_by: number | null; members: number }>(
      `SELECT c.id, c.type, c.created_by,
         (SELECT COUNT(*)::int FROM webchat.members WHERE conversation_id = c.id) AS members
       FROM webchat.conversations c JOIN webchat.members m ON m.conversation_id = c.id
       WHERE m.user_id = $1 ORDER BY c.id FOR UPDATE OF c`,
      [userId],
    );
    if (
      projects.some((p) => p.ownerId === userId && p.memberIds.length > 1) ||
      chats.some((c) => c.type === 'group' && c.created_by === userId && c.members > 1)
    ) {
      return false;
    }
    for (const project of projects) {
      if (project.memberIds.length === 1) await tx.query('DELETE FROM webchat.projects WHERE id = $1', [project.id]);
      else await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [project.id, userId]);
    }
    // The channels of a project deleted above are gone already, so these queries skip them.
    for (const chat of chats) {
      if (chat.type === 'direct' || (chat.type === 'group' && chat.members === 1)) {
        await tx.query('DELETE FROM webchat.conversations WHERE id = $1', [chat.id]);
      } else {
        await leaveChat(tx, chat.id, userId);
      }
    }
    for (const table of ['sessions', 'push_subscriptions', 'bark_devices', 'bark_links', 'github_events', 'github_accounts', 'github_app_grants', 'doc_locks', 'agent_repos']) {
      await tx.query(`DELETE FROM webchat.${table} WHERE user_id = $1`, [userId]);
    }
    // The username is freed. A hyphen is not allowed in one, so nobody can sign up as the stand-in.
    await tx.query(
      `UPDATE webchat.users
       SET username = 'deleted-' || id, display_name = 'Deleted account', password_hash = '', last_active_at = NULL,
         attentive_until = 0, attentive_tab = NULL, attentive_endpoint = NULL, dh_public = NULL, sign_public = NULL,
         key_backup = NULL, agent = FALSE, busy = FALSE, deleted_at = $2
       WHERE id = $1`,
      [userId, Date.now()],
    );
    return true;
  }


  async function leaveChat(q: Querier, conversationId: number, userId: number) {
    await q.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    await q.query('DELETE FROM webchat.conversation_keys WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    await q.query('UPDATE webchat.conversations SET needs_new_key = true WHERE id = $1 AND key_id IS NOT NULL', [
      conversationId,
    ]);
  }

  return { conversations, markRead, insertWrappedKeys, projects, insertChannel, lockProject, chatMembers, projectChannels, canReplace, replaceKey, docs, removeAccount, leaveChat };
}

export type Helpers = ReturnType<typeof createHelpers>;
