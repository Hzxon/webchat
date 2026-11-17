import type { Router } from 'express';
import { notifyAddedToGroup } from '../notify.js';
import { LIMITS } from '../../shared/types.js';
import { HttpError, chatKey, currentUser, inBackground, leaveRefusal, positiveInt, rotatedKey, text, userIds } from './helpers.js';
import type { Context } from './context.js';

export function conversationsRoutes(router: Router, { db, push, config, sweepFiles, requireAuth, requireMember, requireGroupOwner, newOwnerOf, requireKeys, firstKey }: Context) {
  /** Reserves the id of a chat this user is about to create, for the copies of its first key to name (D-111). */
  router.post('/conversations/ids', requireAuth, async (_req, res) => {
    res.json({ id: await db.reserveConversationId(currentUser(res).id) });
  });

  router.post('/conversations/direct', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const otherId = positiveInt(req.body?.userId, 'userId');
    if (otherId === me.id || !(await db.getUser(otherId))) throw new HttpError(404, 'Person not found.');
    let id = await db.findDirect(me.id, otherId);
    if (id === undefined) {
      const memberIds = [me.id, otherId];
      await requireKeys(memberIds);
      const key = await firstKey(req.body?.key, me.id, memberIds);
      id = await db.createConversation('direct', null, memberIds, { ...key, wrappedBy: me.id });
    }
    res.json(await db.conversationFor(me.id, id));
  });

  router.post('/conversations/group', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const title = text(req.body?.title, 'Group name', 1, LIMITS.groupTitleLength);
    const memberIds = userIds(req.body?.memberIds, 'memberIds', me.id);
    if (memberIds.length === 0) throw new HttpError(400, 'Pick at least one person.');
    const allIds = [me.id, ...memberIds];
    await requireKeys(allIds);
    const key = await firstKey(req.body?.key, me.id, allIds);
    const id = await db.createConversation('group', title, allIds, { ...key, wrappedBy: me.id });
    res.status(201).json(await db.conversationFor(me.id, id));
  });

  /** Deletes a group for everyone, with its messages. */
  router.delete('/conversations/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireGroupOwner(conversationId, me.id);
    await db.deleteConversation(conversationId);
    inBackground(sweepFiles(), config.logger);
    res.status(204).end();
  });

  /** Adds people to a group. The member adding them shares its key, so they can read the history. */
  router.post('/conversations/:id/members', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'group') throw new HttpError(400, 'Only a group can take new people.');
    const added = userIds(req.body?.userIds, 'userIds', me.id);
    if (added.length === 0) throw new HttpError(400, 'Pick at least one person.');
    if (added.length > LIMITS.addMembersAtOnce) throw new HttpError(400, 'Too many people at once.');
    await requireKeys(added);
    // Whether the group has a key, and so whether one must come, is checked while the group is locked.
    const key = req.body?.key == null ? null : chatKey(req.body.key, added);
    const result = await db.addGroupMembers(conversationId, me.id, added, key);
    if (result === 'already_member') throw new HttpError(409, 'Someone you picked is already in this group.', 'already_member');
    if (result !== true) throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    const group = (await db.conversationFor(me.id, conversationId))!;
    inBackground(notifyAddedToGroup(push, config, group, me, added), config.logger);
    res.json(group);
  });

  /**
   * Removes someone from a group. The owner's browser sends a new key for the people who stay, so
   * the person removed cannot read what is sent next.
   */
  router.delete('/conversations/:id/members/:userId', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const userId = positiveInt(req.params.userId, 'userId');
    await requireGroupOwner(conversationId, me.id);
    if (userId === me.id) throw new HttpError(400, 'You cannot remove yourself.');
    // Whether the key covers exactly the people who stay is checked while the group is locked.
    const key = req.body?.key == null ? null : rotatedKey(req.body.key);
    if (!(await db.removeGroupMember(conversationId, me.id, userId, key))) {
      throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });

  /**
   * Leaves a group. The person leaving cannot make a new key for the others, so a member who stays
   * replaces it (PUT /conversations/:id/key) before anyone sends again.
   */
  router.post('/conversations/:id/leave', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'group') throw new HttpError(400, 'Only a group can be left.');
    const result = await db.leaveGroup(conversationId, me.id);
    if (result !== true) throw leaveRefusal(result);
    res.status(204).end();
  });

  /** Hands a group to another member. Its owner does this before leaving. */
  router.put('/conversations/:id/owner', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireGroupOwner(conversationId, me.id);
    if (!(await db.handOverGroup(conversationId, me.id, await newOwnerOf(req.body)))) {
      throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });

  /**
   * Replaces a chat's key: after someone left, or when a page finds its copy is from before copies
   * named their chat (K-65). Any member can, and the first one wins.
   */
  router.put('/conversations/:id/key', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    // Whether the key covers exactly the members is checked while the chat is locked.
    if (!(await db.replaceConversationKey(conversationId, me.id, rotatedKey(req.body)))) {
      throw new HttpError(409, 'This chat has a new key already. Reload and try again.', 'stale_key');
    }
    res.json(await db.conversationFor(me.id, conversationId));
  });
}
