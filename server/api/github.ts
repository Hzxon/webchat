import type { Router } from 'express';
import { type Request, type Response } from 'express';
import { parseCookies, safeEqual } from '../auth.js';
import { GithubError } from '../github.js';
import { notifyNewMessage, ringUrgent } from '../notify.js';
import { type GithubDTO } from '../../shared/types.js';
import { GITHUB_APP_COOKIE, GITHUB_STATE_COOKIE, HttpError, currentUser, inBackground, queryOf } from './helpers.js';
import type { Context } from './context.js';

export function githubRoutes(router: Router, { db, push, github, githubApp, config, sessionOf, requireAuth, ownsProject }: Context) {
  /** Where GitHub sends the user back. It must match the callback URL registered on the OAuth App. */
  const githubCallbackUrl = (req: Request) =>
    config.githubCallbackUrl ?? `${req.protocol}://${req.get('host')}/api/github/callback`;

  /** The pane's account and pull requests, and whether projects can link repositories here. */
  const githubView = async (userId: number): Promise<GithubDTO> => ({
    ...(await github.view(userId)),
    appConfigured: githubApp.configured,
  });

  /** The linked GitHub account and its pull requests, fetched again first when the last poll is old. */
  router.get('/github', requireAuth, async (req, res) => {
    const me = currentUser(res);
    await github.refresh(me.id, queryOf(req).get('refresh') === '1');
    res.json(await githubView(me.id));
  });

  /**
   * The page navigates here to link GitHub, and GitHub sends the browser back to /github/callback.
   * Both are page loads, not API calls, so they answer with redirects to the app instead of JSON.
   */
  router.get('/github/connect', async (req, res) => {
    const { user } = await sessionOf(req);
    if (!user || !github.configured) return res.redirect(303, '/?github=error');
    if (!(await db.takeRateLimit(`github:${user.id}`, 10, 15 * 60_000))) return res.redirect(303, '/?github=error');
    const { url, cookie } = github.beginConnect(user.id, githubCallbackUrl(req));
    res.cookie(GITHUB_STATE_COOKIE, cookie, {
      httpOnly: true,
      // Lax still sends it when GitHub redirects back, since that is a top-level page load.
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 10 * 60_000,
      path: '/api/github',
    });
    res.redirect(303, url);
  });

  router.get('/github/callback', async (req, res) => {
    const { user } = await sessionOf(req);
    const cookie = parseCookies(req.headers.cookie)[GITHUB_STATE_COOKIE];
    const query = queryOf(req);
    res.clearCookie(GITHUB_STATE_COOKIE, { path: '/api/github' });
    if (!user || !github.configured) return res.redirect(303, '/?github=error');
    const oauthError = query.get('error');
    if (oauthError) return res.redirect(303, `/?github=${oauthError === 'access_denied' ? 'denied' : 'error'}`);
    try {
      await github.completeConnect(
        user.id,
        cookie,
        query.get('state') ?? '',
        query.get('code') ?? '',
        githubCallbackUrl(req),
      );
    } catch (error) {
      if (error instanceof GithubError) config.logger.warn(`GitHub connect failed for user ${user.id}: ${error.message}`);
      else config.logger.error('GitHub connect failed', error);
      return res.redirect(303, '/?github=error');
    }
    res.redirect(303, '/?github=connected');
  });

  router.patch('/github', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const notify = (req.body as { notify?: unknown } | undefined)?.notify;
    if (typeof notify !== 'boolean') throw new HttpError(400, 'notify must be true or false.');
    await github.setNotify(me.id, notify);
    res.json(await githubView(me.id));
  });

  router.delete('/github', requireAuth, async (_req, res) => {
    const me = currentUser(res);
    await github.disconnect(me.id);
    res.json(await githubView(me.id));
  });

  /** Lets in the database's Supabase Cron jobs, with their own secret, and any other scheduler with CRON_SECRET. */
  const requireScheduler = async (req: Request) => {
    const authorization = req.get('authorization') ?? '';
    if (config.cronSecret && safeEqual(authorization, `Bearer ${config.cronSecret}`)) return;
    const secret = await db.jobSecret();
    if (secret === null || !safeEqual(authorization, `Bearer ${secret}`)) {
      throw new HttpError(401, 'Send the CRON_SECRET as a bearer token.');
    }
  };

  /** Polls every connected account that is due, so alerts arrive while every tab is closed. */
  router.get('/github/poll', async (req, res) => {
    await requireScheduler(req);
    res.json({ polled: await github.pollAll() });
  });

  /** Rings every unread urgent message again, so it rings like an alarm while every tab is closed (D-079). */
  router.get('/urgent/ring', async (req, res) => {
    await requireScheduler(req);
    res.json({ rang: await ringUrgent(db, push) });
  });

  /** Where GitHub sends the owner back after signing in to the GitHub App. It must be a callback URL registered on the app. */
  const githubAppCallbackUrl = (req: Request) =>
    config.githubAppCallbackUrl ?? `${req.protocol}://${req.get('host')}/api/github/app/callback`;

  const githubAppCookie = (req: Request) => ({
    httpOnly: true,
    // Lax still sends it when GitHub redirects back, since that is a top-level page load.
    sameSite: 'lax' as const,
    secure: req.secure,
    maxAge: 15 * 60_000,
    path: '/api/github',
  });

  /** Sends the browser back to the project's repositories dialog, and says how linking went. */
  const backToRepos = (res: Response, projectId: number | null, result: 'repos' | 'repos-denied' | 'repos-error') =>
    res.redirect(303, projectId ? `/?github=${result}&project=${projectId}` : `/?github=${result}`);

  /**
   * The repositories dialog navigates here to install the GitHub App on more repositories. GitHub
   * sends the browser to /github/app/setup afterwards. These routes are page loads, not API calls,
   * so they answer with redirects to the app instead of JSON.
   */
  router.get('/github/app/install', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = Number(queryOf(req).get('project'));
    if (!user || !githubApp.configured || !(await ownsProject(projectId, user.id))) return backToRepos(res, null, 'repos-error');
    res.cookie(GITHUB_APP_COOKIE, githubApp.installCookie(user.id, projectId), githubAppCookie(req));
    res.redirect(303, githubApp.installUrl!);
  });

  /** The Setup URL registered on the app. After an install, the owner signs in to the app to list what they installed it on. */
  router.get('/github/app/setup', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = user ? githubApp.projectOf(parseCookies(req.headers.cookie)[GITHUB_APP_COOKIE], user.id) : null;
    if (!projectId) return res.redirect(303, '/');
    res.redirect(303, `/api/github/app/link?project=${projectId}`);
  });

  /** Starts the sign-in to the GitHub App, which shows the server what the owner can link. */
  router.get('/github/app/link', async (req, res) => {
    const { user } = await sessionOf(req);
    const projectId = Number(queryOf(req).get('project'));
    if (!user || !githubApp.configured || !(await ownsProject(projectId, user.id))) return backToRepos(res, null, 'repos-error');
    if (!(await db.takeRateLimit(`github-app:${user.id}`, 10, 15 * 60_000))) return backToRepos(res, projectId, 'repos-error');
    const { url, cookie } = githubApp.beginLink(user.id, projectId, githubAppCallbackUrl(req));
    res.cookie(GITHUB_APP_COOKIE, cookie, githubAppCookie(req));
    res.redirect(303, url);
  });

  router.get('/github/app/callback', async (req, res) => {
    const { user } = await sessionOf(req);
    const cookie = parseCookies(req.headers.cookie)[GITHUB_APP_COOKIE];
    const query = queryOf(req);
    res.clearCookie(GITHUB_APP_COOKIE, { path: '/api/github' });
    const projectId = user ? githubApp.projectOf(cookie, user.id) : null;
    if (!user || !githubApp.configured || !projectId) return backToRepos(res, null, 'repos-error');
    const oauthError = query.get('error');
    if (oauthError) return backToRepos(res, projectId, oauthError === 'access_denied' ? 'repos-denied' : 'repos-error');
    try {
      await githubApp.completeLink(user.id, cookie, query.get('state') ?? '', query.get('code') ?? '', githubAppCallbackUrl(req));
    } catch (error) {
      if (error instanceof GithubError) config.logger.warn(`GitHub App sign-in failed for user ${user.id}: ${error.message}`);
      else config.logger.error('GitHub App sign-in failed', error);
      return backToRepos(res, projectId, 'repos-error');
    }
    backToRepos(res, projectId, 'repos');
  });

  /**
   * GitHub's webhook for the GitHub App. app.ts hands this route the raw body, which the signature
   * covers. The cards are written before GitHub gets its answer; the pushes go out after.
   */
  router.post('/github/webhook', async (req, res) => {
    if (!githubApp.configured) throw new HttpError(404, 'Not found.');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const cards = await githubApp.receive(
      { signature: req.get('x-hub-signature-256'), event: req.get('x-github-event'), delivery: req.get('x-github-delivery') },
      body,
    );
    if (!cards) throw new HttpError(401, 'The signature does not match.');
    for (const card of cards) inBackground(notifyNewMessage(db, push, config, card, null), config.logger);
    res.status(202).end();
  });
}
