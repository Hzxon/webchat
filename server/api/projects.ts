import type { Router } from 'express';
import { type SharedChannelKey } from '../db.js';
import { notifyAddedToProject } from '../notify.js';
import { LIMITS, type CreateProjectResponse, type ProjectReposDTO } from '../../shared/types.js';
import { HttpError, channelName, chatKey, currentUser, githubId, inBackground, positiveInt, projectRefusal, rotatedChannelKeys, text, userIds } from './helpers.js';
import type { Context } from './context.js';

export function projectsRoutes(router: Router, { db, push, githubApp, config, sweepFiles, requireAuth, requireProjectMember, requireProjectOwner, newOwnerOf, requireKeys, firstKey }: Context) {
  /** Creates a project with its #general channel. Starting alone is fine; members can add people later. */
  router.post('/projects', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const name = text(req.body?.name, 'Project name', 1, LIMITS.projectNameLength);
    const memberIds = userIds(req.body?.memberIds, 'memberIds', me.id);
    if (memberIds.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    const allIds = [me.id, ...memberIds];
    await requireKeys(allIds);
    const key = await firstKey(req.body?.key, me.id, allIds);
    const { projectId, channelId } = await db.createProject(name, me.id, allIds, key);
    const project = (await db.projectFor(me.id, projectId))!;
    if (memberIds.length > 0) inBackground(notifyAddedToProject(push, config, project, channelId, me, memberIds), config.logger);
    const body: CreateProjectResponse = { project, channel: (await db.conversationFor(me.id, channelId))! };
    res.status(201).json(body);
  });

  router.post('/projects/:id/channels', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const name = channelName(req.body?.name);
    // Whether the key covers exactly the project's members is checked while the project is locked.
    const key = await firstKey(req.body?.key, me.id);
    const created = await db.createChannel(projectId, name, me.id, key);
    if (typeof created !== 'number') throw projectRefusal(created);
    res.status(201).json(await db.conversationFor(me.id, created));
  });

  /** Deletes a channel for everyone, with its messages. Only the owner can, and never #general (R-034). */
  router.delete('/projects/:id/channels/:channelId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    const conversationId = positiveInt(req.params.channelId, 'Channel id');
    await requireProjectOwner(projectId, me.id);
    const result = await db.deleteChannel(projectId, conversationId);
    if (result === 'not_found') throw new HttpError(404, 'Channel not found.');
    if (result === 'general') throw new HttpError(400, 'A project keeps its #general channel. Delete the project instead.');
    inBackground(sweepFiles(), config.logger);
    res.status(204).end();
  });

  /** Adds people to a project. The member adding them shares every channel key, so they can read the history. */
  router.post('/projects/:id/members', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const added = userIds(req.body?.userIds, 'userIds', me.id);
    if (added.length === 0) throw new HttpError(400, 'Pick at least one person.');
    if (added.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    await requireKeys(added);
    const list: unknown[] = Array.isArray(req.body?.channelKeys) ? req.body.channelKeys : [];
    const channelKeys: SharedChannelKey[] = list.map((item) => {
      const k = item as { conversationId?: unknown } | undefined;
      return { conversationId: positiveInt(k?.conversationId, 'conversationId'), ...chatKey(item, added) };
    });
    const result = await db.addProjectMembers(projectId, me.id, added, channelKeys);
    if (result !== true) throw projectRefusal(result);
    // The adder can be removed again the moment the change commits.
    const project = await db.projectFor(me.id, projectId);
    if (!project) throw new HttpError(403, 'You are no longer in this project.', 'not_member');
    // #general is the project's first channel.
    const general = channelKeys.length > 0 ? Math.min(...channelKeys.map((k) => k.conversationId)) : null;
    inBackground(notifyAddedToProject(push, config, project, general, me, added), config.logger);
    res.json(project);
  });

  /**
   * Removes someone from a project and every channel in it. The owner's browser sends a new key for
   * each channel, wrapped for the people who stay, so the person removed cannot read what comes next.
   */
  router.delete('/projects/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireProjectOwner(projectId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    // Whether the keys cover exactly the people who stay is checked while the project is locked.
    const result = await db.removeProjectMember(projectId, me.id, userId, rotatedChannelKeys(req.body?.channelKeys));
    if (result !== true) throw projectRefusal(result);
    res.json(await db.projectFor(me.id, projectId));
  });

  /** The repositories a project links, and for its owner, the ones they can link now. */
  async function reposView(projectId: number, userId: number): Promise<ProjectReposDTO> {
    const owner = (await db.getProject(projectId))?.created_by === userId;
    return {
      configured: githubApp.configured,
      repos: await db.projectRepos(projectId),
      choices: owner && githubApp.configured ? await db.githubChoices(userId, projectId) : [],
    };
  }

  /** Every member sees the links; only the owner changes them. */
  router.get('/projects/:id/repos', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    res.json(await reposView(projectId, me.id));
  });

  /**
   * Links a repository to a project, or moves its link to another channel. Only a repository the
   * owner just showed GitHub they reach through the GitHub App, so nobody links one they cannot
   * see. Its pull requests then come in as cards from GitHub's webhook (D-050).
   */
  router.post('/projects/:id/repos', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    const grant = await db.githubGrant(me.id, githubId(req.body?.repoId, 'repoId'));
    if (!grant) {
      throw new HttpError(409, 'Choose the repository on GitHub again, then link it within half an hour.', 'no_grant');
    }
    const result = await db.linkProjectRepo(projectId, grant, positiveInt(req.body?.conversationId, 'conversationId'), me.id);
    if (result === 'no_channel') throw new HttpError(400, 'Pick a channel of this project.');
    if (result === 'too_many') {
      throw new HttpError(409, `A project links at most ${LIMITS.reposPerProject} repositories.`, 'too_many_repos');
    }
    res.json(await reposView(projectId, me.id));
  });

  router.delete('/projects/:id/repos/:repoId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    await db.unlinkProjectRepo(projectId, githubId(req.params.repoId, 'repoId'));
    res.json(await reposView(projectId, me.id));
  });

  /**
   * Leaves a project. The person leaving cannot make new keys for the others, so a member who stays
   * replaces each channel's key (PUT /conversations/:id/key) before anyone sends there again.
   */
  router.post('/projects/:id/leave', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectMember(projectId, me.id);
    const result = await db.leaveProject(projectId, me.id);
    if (result !== true) throw projectRefusal(result);
    res.status(204).end();
  });

  /** Hands a project to another member. Its owner does this before leaving. */
  router.put('/projects/:id/owner', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    if (!(await db.handOverProject(projectId, me.id, await newOwnerOf(req.body)))) {
      throw projectRefusal('stale');
    }
    res.json(await db.projectFor(me.id, projectId));
  });

  /** Deletes a project for everyone, with its channels and their messages. */
  router.delete('/projects/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const projectId = positiveInt(req.params.id, 'Project id');
    await requireProjectOwner(projectId, me.id);
    await db.deleteProject(projectId);
    inBackground(sweepFiles(), config.logger);
    res.status(204).end();
  });
}
