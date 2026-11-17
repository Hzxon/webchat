import type { Router } from 'express';
import { type Request, type Response } from 'express';
import { newCipherKey, newDeviceKey, newLinkToken } from '../bark.js';
import { type BarkDTO } from '../../shared/types.js';
import { BASE64URL, HttpError, currentUser } from './helpers.js';
import type { Context } from './context.js';

export function barkRoutes(router: Router, { db, bark, requireAuth }: Context) {
  // Alerts for iPhones without Web Push, through the Bark app (R-018).

  /** The user's Bark setup as the bell dialog shows it. */
  async function barkView(userId: number): Promise<BarkDTO> {
    const link = bark.configured ? await db.barkLinkFor(userId) : undefined;
    if (!link) return { configured: bark.configured, link: null };
    const devices = await db.barkDevicesFor(userId);
    return {
      configured: true,
      link: {
        serverUrl: `${link.origin}/api/bark/${link.token}`,
        cipherKey: link.cipher_key,
        devices: devices.map((d) => ({ key: d.device_key, registeredAt: d.created_at, seenAt: d.seen_at })),
      },
    };
  }

  /**
   * Where the browser reached this server, which the phone has to reach too: the page's Origin
   * header, since a development proxy rewrites the host; else the host the request asked for.
   */
  const requestOrigin = (req: Request) => {
    const origin = req.get('origin');
    return origin && /^https?:\/\/[^/]+$/.test(origin) ? origin : `${req.protocol}://${req.get('host')}`;
  };

  router.get('/bark', requireAuth, async (_req, res) => {
    res.json(await barkView(currentUser(res).id));
  });

  router.post('/bark/link', requireAuth, async (req, res) => {
    if (!bark.configured) throw new HttpError(409, 'This server has no key for Bark yet.', 'bark_off');
    const me = currentUser(res);
    await db.createBarkLink(me.id, newLinkToken(), requestOrigin(req));
    res.json(await barkView(me.id));
  });

  router.delete('/bark/link', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    await db.deleteBarkLink(me.id);
    res.json(await barkView(me.id));
  });

  /** Turning encryption on makes a fresh key; the person types it into Bark. Off sends alerts plain again. */
  router.put('/bark/encryption', requireAuth, async (req, res) => {
    const me = currentUser(res);
    if (!(await db.barkLinkFor(me.id))) throw new HttpError(404, 'Link Bark first.');
    await db.setBarkCipherKey(me.id, req.body?.enabled === true ? newCipherKey() : null);
    res.json(await barkView(me.id));
  });

  /**
   * The routes the Bark app itself calls, with the link's URL as its server. The app cannot sign
   * in, so the token in the URL is the credential. They answer in the JSON shape Bark expects.
   */
  async function barkLinkOf(req: Request) {
    if (!(await db.takeRateLimit(`bark:${req.ip ?? 'unknown'}`, 120, 15 * 60_000))) {
      throw new HttpError(429, 'Too many requests. Try again in 15 minutes.');
    }
    const token = req.params.token;
    const link =
      typeof token === 'string' && token.length === 43 && BASE64URL.test(token) ? await db.barkLinkByToken(token) : undefined;
    if (!link || !bark.configured) throw new HttpError(404, 'Unknown server link.');
    return link;
  }

  const barkAnswer = (res: Response, message: string, data?: Record<string, string>) =>
    res.json({ code: 200, message, timestamp: Math.floor(Date.now() / 1000), ...(data ? { data } : {}) });

  router.get('/bark/:token/ping', async (req, res) => {
    await barkLinkOf(req);
    barkAnswer(res, 'pong');
  });

  /** Bark sends its APNs token, and the key it was given before, if any, in the query or the body. */
  async function registerBark(req: Request, res: Response) {
    const link = await barkLinkOf(req);
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (...names: string[]) => {
      for (const name of names) {
        const value = query.get(name) ?? body[name];
        if (typeof value === 'string' && value) return value;
      }
      return '';
    };
    const deviceToken = field('devicetoken', 'device_token').toLowerCase();
    const key = field('key', 'device_key');
    if (!/^[0-9a-f]{32,200}$/.test(deviceToken)) throw new HttpError(400, 'device token is invalid');
    if (key && !(key.length === 22 && BASE64URL.test(key))) throw new HttpError(400, 'device key is invalid');
    const device = await db.registerBarkDevice(link.user_id, deviceToken, key || null, newDeviceKey());
    barkAnswer(res, 'success', { key: device.device_key, device_key: device.device_key, device_token: device.device_token });
  }
  router.get('/bark/:token/register', registerBark);
  router.post('/bark/:token/register', registerBark);
}
