import { LIMITS, type FirstChatKeyInput, type RotatedChannelKeyInput } from '../../shared/types.js';
import type { Sql } from '../sql.js';
import { type GithubRepoGrant, type ProjectChangeRefusal, type ProjectRepoRow, type ProjectRow, type SharedChannelKey, one, sameIds, toProjectRepoDTO } from './rows.js';
import type { Helpers } from './helpers.js';

export function projectsQueries(sql: Sql, { insertWrappedKeys, projects, insertChannel, lockProject, projectChannels, canReplace, replaceKey, leaveChat }: Helpers) {
  return {
    /** Creates a project with its members and its #general channel, keyed for every member. */
    createProject(
      name: string,
      createdBy: number,
      memberIds: number[],
      key: FirstChatKeyInput,
    ): Promise<{ projectId: number; channelId: number }> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const project = (await one(
          tx.query<{ id: number }>(
            'INSERT INTO webchat.projects (name, created_by, created_at) VALUES ($1, $2, $3) RETURNING id',
            [name, createdBy, now],
          ),
        ))!;
        for (const userId of memberIds) {
          await tx.query(
            'INSERT INTO webchat.project_members (project_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4)',
            [project.id, userId, createdBy, now],
          );
        }
        const channelId = (await insertChannel(tx, project.id, 'general', memberIds, { ...key, wrappedBy: createdBy }))!;
        return { projectId: project.id, channelId };
      });
    },

    /**
     * Adds a channel to a project. Its key must be wrapped for exactly the project's members at
     * this moment, so a member added meanwhile cannot be left out. An id below #general's would
     * make it #general, which pages tell by the lowest id (D-081, D-111).
     */
    createChannel(
      projectId: number,
      title: string,
      createdBy: number,
      key: FirstChatKeyInput,
    ): Promise<number | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        // Removed since the route checked: the copies would come from someone outside the project.
        if (!memberIds.includes(createdBy)) return 'stale';
        if (!sameIds(memberIds, key.wrappedKeys.map((k) => k.userId))) return 'stale';
        if (key.conversationId < Math.min(...(await projectChannels(tx, projectId)).map((c) => c.id))) return 'stale';
        return (await insertChannel(tx, projectId, title, memberIds, { ...key, wrappedBy: createdBy })) ?? 'name_taken';
      });
    },

    /**
     * Deletes a channel for everyone, with its messages, keys and repository links. Never #general,
     * the project's first channel, whose key opens its docs and board (D-081). It takes the
     * project's lock, as adding or removing people does, since they must bring a key for every
     * channel there is.
     */
    deleteChannel(projectId: number, conversationId: number): Promise<true | 'not_found' | 'general'> {
      return sql.transaction(async (tx) => {
        await lockProject(tx, projectId);
        const ids = (await projectChannels(tx, projectId)).map((c) => c.id);
        if (!ids.includes(conversationId)) return 'not_found';
        if (conversationId === Math.min(...ids)) return 'general';
        await tx.query('DELETE FROM webchat.conversations WHERE id = $1', [conversationId]);
        return true;
      });
    },

    /**
     * Adds people to a project and to every channel in it. Each channel's key must come wrapped for
     * them, so they can read its history. Their read pointers start at the newest message, so that
     * history does not count as unread.
     */
    addProjectMembers(
      projectId: number,
      addedBy: number,
      userIds: number[],
      channelKeys: SharedChannelKey[],
    ): Promise<true | ProjectChangeRefusal> {
      const now = Date.now();
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        // Removed meanwhile: the copies they wrapped would come from someone outside the project.
        if (!memberIds.includes(addedBy)) return 'stale';
        if (userIds.some((id) => memberIds.includes(id))) return 'already_member';
        const channels = await tx.query<{ id: number; key_id: string | null; last_message_id: number }>(
          'SELECT id, key_id, last_message_id FROM webchat.conversations WHERE project_id = $1',
          [projectId],
        );
        const keyFor = new Map(channelKeys.map((k) => [k.conversationId, k]));
        if (channels.length !== keyFor.size || channels.some((c) => keyFor.get(c.id)?.keyId !== c.key_id)) return 'stale';

        for (const userId of userIds) {
          await tx.query(
            'INSERT INTO webchat.project_members (project_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4)',
            [projectId, userId, addedBy, now],
          );
          for (const channel of channels) {
            await tx.query(
              `INSERT INTO webchat.members (conversation_id, user_id, joined_at, last_delivered_id, last_read_id)
               VALUES ($1, $2, $3, $4, $4)`,
              [channel.id, userId, now, channel.last_message_id],
            );
          }
        }
        for (const channel of channels) await insertWrappedKeys(tx, channel.id, addedBy, keyFor.get(channel.id)!.wrappedKeys);
        return true;
      });
    },

    /**
     * Removes someone from a project and from every channel in it. Each channel gets a new key from
     * the member removing them, wrapped for exactly the people who stay, so the person removed
     * cannot read what is sent next. Stale when that person is gone already, or a key changed.
     */
    removeProjectMember(
      projectId: number,
      removedBy: number,
      userId: number,
      channelKeys: RotatedChannelKeyInput[],
    ): Promise<true | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { memberIds } = await lockProject(tx, projectId);
        const staying = memberIds.filter((id) => id !== userId);
        if (staying.length === memberIds.length) return 'stale';
        const channels = await projectChannels(tx, projectId);
        const keyFor = new Map(channelKeys.map((k) => [k.conversationId, k]));
        if (channels.length !== keyFor.size) return 'stale';
        for (const channel of channels) if (!(await canReplace(tx, channel, keyFor.get(channel.id), staying))) return 'stale';

        await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        for (const channel of channels) {
          await tx.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [channel.id, userId]);
          await replaceKey(tx, channel.id, removedBy, keyFor.get(channel.id)!);
        }
        return true;
      });
    },

    /**
     * Takes someone out of a project and every channel in it, at their own request. The owner must
     * hand it over first, so a project always has an owner among its members.
     */
    leaveProject(projectId: number, userId: number): Promise<true | ProjectChangeRefusal> {
      return sql.transaction(async (tx) => {
        const { ownerId, memberIds } = await lockProject(tx, projectId);
        if (!memberIds.includes(userId)) return 'stale';
        if (ownerId === userId) return 'owner';
        await tx.query('DELETE FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        for (const channel of await projectChannels(tx, projectId)) await leaveChat(tx, channel.id, userId);
        return true;
      });
    },

    /** Makes another member the owner. False unless the caller still owns the project and the other person is in it. */
    handOverProject(projectId: number, ownerId: number, newOwnerId: number): Promise<boolean> {
      return sql.transaction(async (tx) => {
        const project = await lockProject(tx, projectId);
        if (project.ownerId !== ownerId || !project.memberIds.includes(newOwnerId)) return false;
        await tx.query('UPDATE webchat.projects SET created_by = $2 WHERE id = $1', [projectId, newOwnerId]);
        return true;
      });
    },

    /** Deletes a project for everyone. Its channels, their messages and their keys go with it. */
    deleteProject: async (projectId: number) => {
      await sql.query('DELETE FROM webchat.projects WHERE id = $1', [projectId]);
    },

    projectsFor: (userId: number) => projects(userId, null),
    projectFor: async (userId: number, projectId: number) => (await projects(userId, projectId))[0],
    getProject: (projectId: number) =>
      one(sql.query<ProjectRow>('SELECT * FROM webchat.projects WHERE id = $1', [projectId])),
    isProjectMember: async (projectId: number, userId: number) =>
      (
        await sql.query('SELECT 1 FROM webchat.project_members WHERE project_id = $1 AND user_id = $2', [
          projectId,
          userId,
        ])
      ).length > 0,

    projectRepos: async (projectId: number) =>
      (
        await sql.query<ProjectRepoRow>(
          `SELECT repo_id, repo, conversation_id, added_by, added_at FROM webchat.project_repos
           WHERE project_id = $1 ORDER BY lower(repo)`,
          [projectId],
        )
      ).map(toProjectRepoDTO),

    /**
     * Links a repository someone reaches through the GitHub App to a project, or moves its link to
     * another channel. Refused when the channel is not one of the project's, or the project links
     * as many repositories as it may.
     */
    linkProjectRepo(projectId: number, grant: GithubRepoGrant, conversationId: number, addedBy: number) {
      return sql.transaction(async (tx): Promise<true | 'no_channel' | 'too_many'> => {
        await lockProject(tx, projectId);
        const channel = await tx.query('SELECT 1 FROM webchat.conversations WHERE id = $1 AND project_id = $2', [
          conversationId,
          projectId,
        ]);
        if (channel.length === 0) return 'no_channel';
        const others = await one(
          tx.query<{ count: number }>(
            'SELECT COUNT(*)::int AS count FROM webchat.project_repos WHERE project_id = $1 AND repo_id <> $2',
            [projectId, grant.repoId],
          ),
        );
        if ((others?.count ?? 0) >= LIMITS.reposPerProject) return 'too_many';
        await tx.query(
          `INSERT INTO webchat.project_repos (project_id, repo_id, repo, installation_id, conversation_id, added_by, added_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (project_id, repo_id) DO UPDATE SET
             repo = EXCLUDED.repo, installation_id = EXCLUDED.installation_id, conversation_id = EXCLUDED.conversation_id`,
          [projectId, grant.repoId, grant.repo, grant.installationId, conversationId, addedBy, Date.now()],
        );
        return true;
      });
    },
    unlinkProjectRepo: async (projectId: number, repoId: number) => {
      await sql.query('DELETE FROM webchat.project_repos WHERE project_id = $1 AND repo_id = $2', [projectId, repoId]);
    },
  };
}
