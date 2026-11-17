import type { Router } from 'express';
import { toUserDTO } from '../db.js';
import { type BootstrapDTO, type SyncRequest, type SyncResponse } from '../../shared/types.js';
import { MAX_ID, checkedInRepos, currentUser } from './helpers.js';
import type { Context } from './context.js';

export function syncRoutes(router: Router, { db, requireAuth, markDeliveredFrom }: Context) {
  router.get('/bootstrap', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    // The fingerprint first: a change that lands while the rest loads then makes the first
    // check-in answer "changed" instead of being counted as seen without being sent.
    const stamp = await db.stamp(me.id);
    const [users, projects, conversations, cursor, urgent, docs] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      db.latestMessageId(me.id),
      db.unreadUrgent(me.id),
      db.docsFor(me.id),
    ]);
    const now = Date.now();
    const body: BootstrapDTO = {
      me: toUserDTO(me, now),
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      cursor,
      stamp,
      urgent,
      docs,
    };
    res.json(body);
  });

  /**
   * The client's check-in. It reports whether the user is looking at the app and gets back what
   * changed. A cheap fingerprint check answers most calls without loading anything else.
   */
  router.post('/sync', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const input = (req.body ?? {}) as Partial<SyncRequest>;
    const cursor = Number.isInteger(input.cursor) && input.cursor! >= 0 ? Math.min(input.cursor!, MAX_ID) : 0;
    const tabId = typeof input.tabId === 'string' ? input.tabId.slice(0, 64) : '';
    const endpoint = typeof input.endpoint === 'string' && input.endpoint.length <= 1000 ? input.endpoint : null;

    const editing = input.editing;
    await Promise.all([
      db.checkIn(me.id, input.attentive === true, tabId, endpoint, checkedInRepos(input), Number.isInteger(input.protocol) && input.protocol! > 0 && input.protocol! < 100 ? input.protocol : 0, Array.isArray(input.repos)),
      typeof editing?.docId === 'string' && typeof editing.section === 'string'
        ? db.renewSectionLock(me.id, editing.docId.slice(0, 64), editing.section.slice(0, 64))
        : undefined,
    ]);
    const stamp = await db.stamp(me.id);
    if (stamp === input.stamp) {
      const body: SyncResponse = { changed: false, stamp, cursor };
      return res.json(body);
    }

    const messages = await db.messagesSince(me.id, cursor);
    await markDeliveredFrom(me.id, messages);
    // Marking messages delivered changes the fingerprint, so read it again, and before the rest, as
    // the bootstrap does: a change that lands while they load, such as an agent's folder, then makes
    // the next check-in answer "changed" instead of leaving the page on the older list (K-70).
    const newStamp = await db.stamp(me.id);
    const [users, projects, conversations, docs] = await Promise.all([
      db.listUsers(),
      db.projectsFor(me.id),
      db.conversationsFor(me.id),
      db.docsFor(me.id),
    ]);
    const newCursor = messages.reduce((max, m) => Math.max(max, m.id), cursor);
    // Each read above sees its own moment. A message that committed after messagesSince, or past
    // its page limit, is already counted in newStamp. Returning that stamp would make every later
    // check-in answer "unchanged" without the message, so send no stamp and ask for another round.
    const more = (await db.latestMessageId(me.id)) > newCursor;
    const now = Date.now();
    const body: SyncResponse = {
      changed: true,
      stamp: more ? '' : newStamp,
      more,
      cursor: newCursor,
      users: users.filter((u) => u.id !== me.id).map((u) => toUserDTO(u, now)),
      projects,
      conversations,
      messages,
      docs,
    };
    res.json(body);
  });

  /** Sent with navigator.sendBeacon when a tab closes, so pushes go to the phone right away. */
  router.post('/away', requireAuth, async (req, res) => {
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId.slice(0, 64) : '';
    await db.checkIn(currentUser(res).id, false, tabId, null);
    res.status(204).end();
  });
}
