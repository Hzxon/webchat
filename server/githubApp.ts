// GitHub App: how a project links repositories, and how GitHub tells WebChat about their pull
// requests (D-050).
//
// A project's owner installs the app on a repository on GitHub, then signs in to the app once, so
// the server sees which repositories they reach through it. Only those can they link. GitHub then
// sends a webhook for every pull request event in the repositories the app is installed on, and the
// server writes a card into each channel that links one. The app can only read pull requests, and
// the server keeps none of its tokens: it uses the sign-in once to list repositories, then revokes it.
import crypto from 'node:crypto';
import { LIMITS, type GithubCardDTO, type MessageDTO, type PullCardDTO, type PullEvent } from '../shared/types.js';
import { safeEqual } from './auth.js';
import type { Config } from './config.js';
import type { Db, GithubRepoGrant } from './db.js';
import { GithubError } from './github.js';

const REST_API_VERSION = '2022-11-28';
/** Installations read when someone signs in to link a repository. A student has a few. */
const MAX_INSTALLATIONS = 20;
/** Repositories read from each installation. */
const REPOS_PER_INSTALLATION = 100;

/** The parts of GitHub's pull_request webhook that a card needs. */
export interface PullRequestWebhook {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    draft?: boolean;
    merged?: boolean;
    user?: { login?: string } | null;
    merged_by?: { login?: string } | null;
    requested_reviewers?: Array<{ login?: string } | null> | null;
    assignees?: Array<{ login?: string } | null> | null;
  };
  repository?: { id?: number; full_name?: string };
  sender?: { login?: string } | null;
}

interface InstallationWebhook {
  action?: string;
  installation?: { id?: number };
  repositories_removed?: Array<{ id?: number }>;
}

/** The pull request actions a card is posted for. Others, such as new commits or edits, stay quiet. */
const CARD_EVENTS: Record<string, PullEvent> = {
  opened: 'opened',
  ready_for_review: 'ready',
  reopened: 'reopened',
  closed: 'closed',
};

const loginsOf = (list: Array<{ login?: string } | null> | null | undefined) =>
  (list ?? []).flatMap((p) => (typeof p?.login === 'string' ? [p.login] : [])).slice(0, LIMITS.pullPeople);

/**
 * The card for a pull_request webhook, and the repository it belongs to. Null for an action no card
 * is posted for. A team asked to review is left out, as in the Pull requests pane.
 */
export function cardFromWebhook(payload: PullRequestWebhook): { repoId: number; card: GithubCardDTO } | null {
  const { pull_request: pr, repository: repo, action = '' } = payload;
  if (!pr || !Object.hasOwn(CARD_EVENTS, action) || typeof pr.number !== 'number') return null;
  if (typeof repo?.id !== 'number' || typeof repo.full_name !== 'string') return null;
  const event: PullEvent = action === 'closed' && pr.merged ? 'merged' : CARD_EVENTS[action]!;
  const pull: PullCardDTO = {
    repo: repo.full_name,
    number: pr.number,
    title: String(pr.title ?? '').slice(0, LIMITS.pullTitleLength),
    url: `https://github.com/${repo.full_name}/pull/${pr.number}`,
    draft: pr.draft === true,
    // The webhook says nothing of checks, reviews or conflicts.
    review: null,
    checks: null,
    conflicts: false,
    reviewers: loginsOf(pr.requested_reviewers),
    assignees: loginsOf(pr.assignees),
  };
  const sender = payload.sender?.login ?? null;
  const actor = event === 'opened' ? null : event === 'merged' ? (pr.merged_by?.login ?? sender) : sender;
  return { repoId: repo.id, card: { event, pull, author: pr.user?.login ?? null, actor } };
}

/** What the browser keeps in a cookie while the owner is on GitHub: the project, and the sign-in's state. */
function readLinkCookie(cookie: string | undefined) {
  const [userId, projectId, state, verifier] = (cookie ?? '').split('.');
  return { userId: Number(userId), projectId: Number(projectId), state, verifier };
}

export type GithubApp = ReturnType<typeof createGithubApp>;

export function createGithubApp(db: Db, config: Config) {
  const {
    githubAppSlug: slug,
    githubAppClientId: clientId,
    githubAppClientSecret: clientSecret,
    githubWebhookSecret: webhookSecret,
  } = config;
  const configured = Boolean(slug && clientId && clientSecret && webhookSecret);

  async function rest<T>(token: string, path: string): Promise<T> {
    const res = await fetch(`${config.githubApiUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'WebChat',
        'x-github-api-version': REST_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new GithubError(`GitHub answered ${res.status}.`);
    return (await res.json()) as T;
  }

  /** Every repository the token's user reaches through the app, with the installation that covers it. */
  async function reachableRepos(token: string): Promise<GithubRepoGrant[]> {
    const { installations } = await rest<{ installations: Array<{ id: number }> }>(
      token,
      `/user/installations?per_page=${MAX_INSTALLATIONS}`,
    );
    const grants: GithubRepoGrant[] = [];
    for (const installation of installations.slice(0, MAX_INSTALLATIONS)) {
      const { repositories } = await rest<{ repositories: Array<{ id: number; full_name: string }> }>(
        token,
        `/user/installations/${installation.id}/repositories?per_page=${REPOS_PER_INSTALLATION}`,
      );
      for (const repo of repositories) grants.push({ repoId: repo.id, repo: repo.full_name, installationId: installation.id });
    }
    return grants;
  }

  /** Revokes the sign-in's token once the repositories are listed, so no token of the app is left anywhere. */
  async function revoke(token: string) {
    const res = await fetch(`${config.githubApiUrl}/applications/${encodeURIComponent(clientId!)}/token`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'WebChat',
        'x-github-api-version': REST_API_VERSION,
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      config.logger.warn(`Could not revoke a GitHub App token: ${String(error)}`);
      return null;
    });
    if (res && !res.ok && res.status !== 404) config.logger.warn(`Could not revoke a GitHub App token (${res.status}).`);
  }

  /** Writes a card into every channel that links the repository. Returns the cards, to push. */
  async function postCard(payload: PullRequestWebhook): Promise<MessageDTO[]> {
    const found = cardFromWebhook(payload);
    if (!found) return [];
    const channels = await db.githubChannelsFor(found.repoId, found.card.pull.repo);
    const body = JSON.stringify(found.card);
    const cards: MessageDTO[] = [];
    for (const conversationId of channels) cards.push(await db.insertGithubCard(conversationId, body));
    return cards;
  }

  async function handle(event: string | undefined, payload: unknown): Promise<MessageDTO[]> {
    if (event === 'pull_request') return postCard(payload as PullRequestWebhook);
    const { action, installation, repositories_removed: removed } = payload as InstallationWebhook;
    if (typeof installation?.id !== 'number') return [];
    // Uninstalled, or taken off some repositories: GitHub sends nothing more for them, so their links go.
    if (event === 'installation' && (action === 'deleted' || action === 'suspend')) await db.dropGithubInstallation(installation.id);
    if (event === 'installation_repositories' && action === 'removed') {
      await db.dropGithubInstallation(
        installation.id,
        (removed ?? []).flatMap((r) => (typeof r.id === 'number' ? [r.id] : [])),
      );
    }
    return [];
  }

  return {
    configured,

    /** The app's page on GitHub, where its owner installs it on repositories. */
    installUrl: configured ? new URL(`/apps/${encodeURIComponent(slug!)}/installations/new`, config.githubOauthUrl).toString() : null,

    /** The project a link cookie names, if it belongs to this user. */
    projectOf(cookie: string | undefined, userId: number): number | null {
      const link = readLinkCookie(cookie);
      return link.userId === userId && Number.isInteger(link.projectId) && link.projectId > 0 ? link.projectId : null;
    },

    /** The cookie that remembers the project while its owner installs the app on GitHub. */
    installCookie: (userId: number, projectId: number) => `${userId}.${projectId}`,

    /**
     * Starts the sign-in to the app: returns GitHub's sign-in URL, and the value to keep in a
     * short-lived cookie until GitHub sends the owner back. The state stops another site from
     * planting its own sign-in; PKCE makes a stolen code useless.
     */
    beginLink(userId: number, projectId: number, redirectUri: string): { url: string; cookie: string } {
      const state = crypto.randomBytes(24).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const url = new URL('/login/oauth/authorize', config.githubOauthUrl);
      url.search = new URLSearchParams({
        client_id: clientId!,
        redirect_uri: redirectUri,
        state,
        allow_signup: 'false',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.toString(), cookie: [userId, projectId, state, verifier].join('.') };
    },

    /**
     * Finishes the sign-in: records which repositories the owner reaches through the app, for half
     * an hour, so they can link one of them. Returns how many there are.
     */
    async completeLink(userId: number, cookie: string | undefined, state: string, code: string, redirectUri: string) {
      const link = readLinkCookie(cookie);
      if (link.userId !== userId || !link.state || !link.verifier || !state || !safeEqual(link.state, state)) {
        throw new GithubError('The GitHub sign-in expired or was started in another browser. Try again.');
      }
      const res = await fetch(new URL('/login/oauth/access_token', config.githubOauthUrl), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'WebChat' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: link.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // GitHub reports a bad code in the body, not always with an error status.
      const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!res.ok || !data.access_token) throw new GithubError(`GitHub refused the sign-in (${data.error ?? res.status}).`);
      try {
        const grants = await reachableRepos(data.access_token);
        await db.saveGithubGrants(userId, grants);
        return grants.length;
      } finally {
        await revoke(data.access_token);
      }
    },

    /**
     * Handles one webhook delivery and returns the cards it wrote, or null when its signature does
     * not match, so it did not come from GitHub. A delivery GitHub sends again is handled once.
     */
    async receive(
      headers: { signature: string | undefined; event: string | undefined; delivery: string | undefined },
      body: Buffer,
    ): Promise<MessageDTO[] | null> {
      const expected = `sha256=${crypto.createHmac('sha256', webhookSecret!).update(body).digest('hex')}`;
      if (!headers.signature || !safeEqual(headers.signature, expected)) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return [];
      }
      const delivery = headers.delivery?.slice(0, 100);
      if (delivery && !(await db.claimGithubDelivery(delivery))) return [];
      try {
        return await handle(headers.event, payload);
      } catch (error) {
        // Let GitHub's redelivery, or a manual one from the app's settings, try again.
        if (delivery) await db.releaseGithubDelivery(delivery);
        throw error;
      }
    },
  };
}
