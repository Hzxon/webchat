import type { Router } from 'express';
import type { PushSubscriptionInput } from '../push.js';
import { type PushPayload } from '../../shared/types.js';
import { HttpError, currentUser } from './helpers.js';
import type { Context } from './context.js';

export function pushRoutes(router: Router, { db, push, requireAuth }: Context) {
  router.post('/push/subscribe', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const subscription = req.body as Partial<PushSubscriptionInput> | undefined;
    const endpoint = subscription?.endpoint;
    const { p256dh, auth } = subscription?.keys ?? {};
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
      throw new HttpError(400, 'Subscription is incomplete.');
    }
    if (endpoint.length > 1000 || p256dh.length > 200 || auth.length > 100 || !push.isAllowedEndpoint(endpoint)) {
      throw new HttpError(400, 'This push service is not supported.');
    }
    // The sizes a browser's P-256 public key and auth secret have. web-push throws on others (K-12).
    if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
      throw new HttpError(400, 'Subscription keys are invalid.');
    }
    if (!(await db.savePushSubscription(me.id, endpoint, p256dh, auth))) {
      throw new HttpError(409, 'Another account holds this push subscription.', 'endpoint_taken');
    }
    res.status(204).end();
  });

  router.post('/push/unsubscribe', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (typeof req.body?.endpoint === 'string') await db.deleteUserPushSubscription(req.body.endpoint, me.id);
    res.status(204).end();
  });
  router.post('/push/test', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    const payload: PushPayload = {
      kind: 'test',
      title: 'Notifications work',
      body: 'This is how new messages will reach you.',
      bodyPrefix: '',
      urgent: false,
      tag: 'test',
      conversationId: null,
      messageId: null,
      senderId: null,
      clientId: null,
      envelope: null,
      unreadTotal: null,
      sentAt: Date.now(),
      url: null,
    };
    res.json(await push.sendToUser(me.id, payload));
  });
}
