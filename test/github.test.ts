import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import ece from 'http_ece';
import { createApp, type WebChatApp } from '../server/app.ts';
import { newSessionToken } from '../server/auth.ts';
import type { Config } from '../server/config.ts';
import { comparePulls } from '../server/github.ts';
import type { GithubDTO, ProjectRepoDTO, PullListsDTO, PullRequestDTO, PushPayload } from '../shared/types.ts';

const CLIENT_ID = 'Iv1.test-client';
const CLIENT_SECRET = 'test-client-secret';
const CRON_SECRET = 'test-cron-secret';
const TOKEN = 'gho_test_access_token';

interface FakePull {
  id: string;
  number: number;
  title: string;
  author: string;
  review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  checks?: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  conflicting?: boolean;
  comments?: number;
  lastCommenter?: string;
  /** "owner/name"; acme/app unless set. */
  repo?: string;
  draft?: boolean;
  /** Requested reviewers: people by login, teams as "org/team". */
  reviewers?: string[];
  teams?: string[];
  /** A requested reviewer the token cannot see, which GitHub answers with null. */
  hiddenReviewer?: boolean;
  assignees?: string[];
}

/** Stands in for github.com and api.github.com: OAuth, the user, GraphQL search, and grant deletion. */
async function startFakeGithub() {
  const state = {
    /** The token GitHub accepts; set to something else to act as if the user revoked access. */
    validToken: TOKEN,
    challenge: '',
    reviewRequested: [] as FakePull[],
    authored: [] as FakePull[],
    /** What the States query answers for pull requests that left the open list. */
    endings: new Map<string, { state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedBy?: string }>(),
    searches: [] as string[],
    revoked: [] as Array<{ authorization: string | undefined; body: unknown }>,
  };

  const toNode = (p: FakePull) => ({
    id: p.id,
    number: p.number,
    title: p.title,
    url: `https://github.com/${p.repo ?? 'acme/app'}/pull/${p.number}`,
    isDraft: p.draft ?? false,
    updatedAt: new Date().toISOString(),
    additions: 10,
    deletions: 2,
    reviewDecision: p.review ?? null,
    mergeable: p.conflicting ? 'CONFLICTING' : 'MERGEABLE',
    repository: { nameWithOwner: p.repo ?? 'acme/app' },
    author: { login: p.author },
    comments: { totalCount: p.comments ?? 0, nodes: p.lastCommenter ? [{ author: { login: p.lastCommenter } }] : [] },
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
    reviewRequests: {
      nodes: [
        ...(p.reviewers ?? []).map((login) => ({ requestedReviewer: { login } })),
        ...(p.teams ?? []).map((combinedSlug) => ({ requestedReviewer: { combinedSlug } })),
        ...(p.hiddenReviewer ? [{ requestedReviewer: null }] : []),
      ],
    },
    assignees: { nodes: (p.assignees ?? []).map((login) => ({ login })) },
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const body = text ? (JSON.parse(text) as Record<string, any>) : {};
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      const authorized = req.headers.authorization === `Bearer ${state.validToken}`;

      if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
        const verifierOk = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url') === state.challenge;
        if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return json(200, { error: 'incorrect_client_credentials' });
        if (body.code !== 'good-code' || !verifierOk) return json(200, { error: 'bad_verification_code' });
        return json(200, { access_token: TOKEN, scope: 'repo', token_type: 'bearer' });
      }
      if (req.method === 'GET' && req.url === '/user') {
        return authorized ? json(200, { id: 4242, login: 'octo', name: 'Octo Cat' }) : json(401, { message: 'Bad credentials' });
      }
      if (req.method === 'POST' && req.url === '/graphql') {
        if (!authorized) return json(401, { message: 'Bad credentials' });
        const query = String(body.query);
        if (query.includes('query Pulls')) {
          state.searches.push(body.variables.reviewQuery, body.variables.authoredQuery);
          return json(200, {
            data: {
              viewer: { login: 'octo' },
              reviewRequested: { nodes: state.reviewRequested.map(toNode) },
              authored: { nodes: state.authored.map(toNode) },
            },
          });
        }
        if (query.includes('query States')) {
          const nodes = (body.variables.ids as string[]).map((id) => {
            const ending = state.endings.get(id);
            return ending ? { id, state: ending.state, mergedBy: ending.mergedBy ? { login: ending.mergedBy } : null } : null;
          });
          return json(200, { data: { nodes } });
        }
      }
      if (req.method === 'DELETE' && req.url === `/applications/${CLIENT_ID}/grant`) {
        state.revoked.push({ authorization: req.headers.authorization, body });
        return res.writeHead(204).end();
      }
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Stands in for a browser push service such as FCM, and records what the server sends to it. */
async function startFakePushService() {
  const received: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeSubscription(endpoint: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return {
    json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } },
    decrypt: (body: Buffer) =>
      JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString()) as PushPayload,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GitHub connector', () => {
  let instance: WebChatApp;
  let server: http.Server;
  let baseUrl: string;
  let github: Awaited<ReturnType<typeof startFakeGithub>>;
  let pushService: Awaited<ReturnType<typeof startFakePushService>>;
  let cookie = '';
  let userId = 0;

  async function request<T>(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { res, status: res.status, data: (text && /^[[{]/.test(text) ? JSON.parse(text) : undefined) as T };
  }

  /** Lets the next request poll GitHub again instead of waiting out the minimum interval. */
  const pollDue = () => instance.sql.query('UPDATE webchat.github_accounts SET polled_at = 0');

  /** The connector does not touch encryption, so a user row and a session are enough. */
  async function addUser(username: string, displayName: string) {
    const [user] = await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.users (username, display_name, password_hash, created_at, auth_version)
       VALUES ($1, $2, 'unused', $3, 2) RETURNING id`,
      [username, displayName, Date.now()],
    );
    const { token, tokenHash } = newSessionToken();
    await instance.sql.query('INSERT INTO webchat.sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      tokenHash,
      user!.id,
      Date.now(),
      Date.now() + 3600_000,
    ]);
    return { id: user!.id, cookie: `webchat_sid=${token}` };
  }

  /** A project whose first member owns it, with a #general channel for every member. Its key is never used here. */
  async function addProject(name: string, memberIds: number[]) {
    const now = Date.now();
    const [project] = await instance.sql.query<{ id: number }>(
      'INSERT INTO webchat.projects (name, created_by, created_at) VALUES ($1, $2, $3) RETURNING id',
      [name, memberIds[0], now],
    );
    const [general] = await instance.sql.query<{ id: number }>(
      `INSERT INTO webchat.conversations (type, title, project_id, created_at, updated_at, key_id)
       VALUES ('channel', 'general', $1, $2, $2, $3) RETURNING id`,
      [project!.id, now, 'k'.repeat(22)],
    );
    for (const id of memberIds) {
      await instance.sql.query('INSERT INTO webchat.project_members (project_id, user_id, added_by, joined_at) VALUES ($1, $2, $3, $4)', [
        project!.id,
        id,
        memberIds[0],
        now,
      ]);
      await instance.sql.query('INSERT INTO webchat.members (conversation_id, user_id, joined_at) VALUES ($1, $2, $3)', [general!.id, id, now]);
    }
    return { projectId: project!.id, generalId: general!.id };
  }

  before(async () => {
    github = await startFakeGithub();
    pushService = await startFakePushService();
    const silent = { info() {}, warn() {}, error() {} };
    const config: Config = {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: undefined,
      databaseCaCert: undefined,
      pgliteDir: ':memory:',
      inviteCode: 'friends-only',
      vapidPublicKey: undefined,
      vapidPrivateKey: undefined,
      vapidSubject: 'mailto:test@example.com',
      trustProxy: false,
      sessionDays: 1,
      extraPushHosts: [pushService.host],
      clientDir: null,
      githubClientId: CLIENT_ID,
      githubClientSecret: CLIENT_SECRET,
      githubCallbackUrl: undefined,
      githubOauthUrl: github.url,
      githubApiUrl: github.url,
      githubPollSeconds: 0,
      cronSecret: CRON_SECRET,
      build: undefined,
      logger: silent,
    };
    instance = await createApp(config);
    server = http.createServer(instance.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    ({ id: userId, cookie } = await addUser('dana', 'Dana'));

    github.state.authored = [
      { id: 'PR_mine_1', number: 1, title: 'Add login page', author: 'octo', review: 'REVIEW_REQUIRED', checks: 'PENDING' },
      { id: 'PR_mine_2', number: 2, title: 'Fix typo', author: 'octo', checks: 'SUCCESS', comments: 1, lastCommenter: 'alice' },
      { id: 'PR_mine_3', number: 3, title: 'Bump deps', author: 'octo' },
    ];
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await instance?.close();
    await github?.close();
    await pushService?.close();
  });

  test('connecting sends the browser to GitHub with a state and a PKCE challenge', async () => {
    const { status, res } = await request('GET', '/github/connect');
    assert.equal(status, 303);
    const location = new URL(res.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, `${github.url}/login/oauth/authorize`);
    assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(location.searchParams.get('scope'), 'repo');
    assert.equal(location.searchParams.get('redirect_uri'), `${baseUrl}/api/github/callback`);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.match(res.headers.get('set-cookie') ?? '', /webchat_github=.+HttpOnly/i);
  });

  test('the callback refuses a state from anywhere else, and reports a cancelled sign-in', async () => {
    const { res } = await request('GET', '/github/connect');
    const stateCookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie: `${cookie}; ${stateCookie}` };

    const forged = await request('GET', '/github/callback?code=good-code&state=attacker', { headers });
    assert.equal(forged.res.headers.get('location'), '/?github=error');
    const noCookie = await request('GET', `/github/callback?code=good-code&state=${new URL(res.headers.get('location')!).searchParams.get('state')}`);
    assert.equal(noCookie.res.headers.get('location'), '/?github=error');
    const denied = await request('GET', '/github/callback?error=access_denied&state=x', { headers });
    assert.equal(denied.res.headers.get('location'), '/?github=denied');

    assert.equal((await request<GithubDTO>('GET', '/github')).data.account, null);
  });

  test('a completed sign-in stores the token encrypted and loads the pull requests', async () => {
    const { res } = await request('GET', '/github/connect');
    const authorize = new URL(res.headers.get('location')!);
    github.state.challenge = authorize.searchParams.get('code_challenge')!;
    const stateCookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const callback = await request('GET', `/github/callback?code=good-code&state=${authorize.searchParams.get('state')}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    assert.equal(callback.res.headers.get('location'), '/?github=connected');

    const [row] = await instance.sql.query<{ token: string; github_id: number }>('SELECT token, github_id FROM webchat.github_accounts');
    assert.equal(row!.github_id, 4242);
    assert.ok(!row!.token.includes(TOKEN), 'the token is not stored in plain text');

    const { data } = await request<GithubDTO>('GET', '/github');
    assert.deepEqual(data.account, { login: 'octo', name: 'Octo Cat', notify: true, autoShare: true });
    assert.deepEqual(
      data.pulls!.authored.map((p) => [p.number, p.review, p.checks]),
      [
        [1, 'review_required', 'pending'],
        [2, null, 'success'],
        [3, null, null],
      ],
    );
    assert.deepEqual(data.events, [], 'the first poll only records the pull requests');
    assert.ok(github.state.searches.includes('is:pr is:open archived:false sort:updated-desc review-requested:octo'));
    assert.ok(!JSON.stringify(data).includes(TOKEN), 'the token never reaches the browser');
  });

  test('changes between polls become events and pushes, but not the user’s own comments', async () => {
    const phone = makeSubscription(`http://${pushService.host}/dana-phone`);
    assert.equal((await request('POST', '/push/subscribe', { body: phone.json })).status, 204);
    pushService.received.length = 0;

    github.state.reviewRequested = [{ id: 'PR_theirs_9', number: 9, title: 'Refactor API', author: 'alice' }];
    github.state.authored = [
      { id: 'PR_mine_1', number: 1, title: 'Add login page', author: 'octo', review: 'APPROVED', checks: 'FAILURE' },
      { id: 'PR_mine_2', number: 2, title: 'Fix typo', author: 'octo', checks: 'SUCCESS', comments: 2, lastCommenter: 'octo' },
    ];
    github.state.endings.set('PR_mine_3', { state: 'MERGED', mergedBy: 'hubot' });
    await pollDue();

    const { data } = await request<GithubDTO>('GET', '/github');
    assert.deepEqual(
      data.events.map((e) => [e.kind, e.number, e.actor]).sort(),
      [
        ['approved', 1, null],
        ['checks_failed', 1, null],
        ['merged', 3, 'hubot'],
        ['review_requested', 9, 'alice'],
      ],
    );
    assert.deepEqual(data.pulls!.reviewRequested.map((p) => p.number), [9]);

    // Several changes at once: only the three that need the user most are pushed. All stay in the activity list.
    const deadline = Date.now() + 3000;
    while (pushService.received.length < 3 && Date.now() < deadline) await sleep(20);
    await sleep(100);
    const payloads = pushService.received.map((body) => phone.decrypt(body));
    assert.deepEqual(payloads.map((p) => p.title).sort(), [
      'Checks failed on your pull request',
      'Your pull request was approved',
      'alice asked for your review',
    ]);
    for (const payload of payloads) {
      assert.equal(payload.kind, 'github');
      assert.match(payload.url!, /^https:\/\/github\.com\/acme\/app\/pull\/\d+$/);
      assert.match(payload.tag, /^github-acme\/app#\d+$/);
    }
    assert.equal(payloads.find((p) => p.title === 'alice asked for your review')!.body, 'Refactor API (acme/app#9)');
    assert.equal(data.events[0]!.kind, 'review_requested', 'the most important change is the newest event');
  });

  test('with alerts off, changes are still recorded but nothing is pushed', async () => {
    assert.equal((await request<GithubDTO>('PATCH', '/github', { body: { notify: false } })).data.account!.notify, false);
    pushService.received.length = 0;
    github.state.authored[1] = { ...github.state.authored[1]!, comments: 3, lastCommenter: 'bob' };
    await pollDue();

    const { data } = await request<GithubDTO>('GET', '/github');
    assert.deepEqual([data.events[0]!.kind, data.events[0]!.actor], ['commented', 'bob']);
    await sleep(200);
    assert.equal(pushService.received.length, 0);
  });

  let eve: Awaited<ReturnType<typeof addUser>>;
  let capstone: Awaited<ReturnType<typeof addProject>>;

  test('only a project’s owner links a repository, and every member sees the links', async () => {
    eve = await addUser('eve', 'Eve');
    const finn = await addUser('finn', 'Finn');
    capstone = await addProject('Capstone', [userId, eve.id]);
    const path = `/projects/${capstone.projectId}/repos`;
    const general = capstone.generalId;

    const asEve = await request<{ code?: string }>('POST', path, { headers: { cookie: eve.cookie }, body: { repo: 'acme/app', conversationId: general } });
    assert.deepEqual([asEve.status, asEve.data.code], [403, 'not_owner']);
    assert.equal((await request('GET', path, { headers: { cookie: finn.cookie } })).status, 404, 'outsiders do not see them');
    assert.equal((await request('POST', path, { body: { repo: 'not a repository', conversationId: general } })).status, 400);
    assert.equal((await request('POST', path, { body: { repo: 'acme/app', conversationId: 999_999 } })).status, 400, 'only into its own channels');

    const linked = await request<ProjectRepoDTO[]>('POST', path, { body: { repo: 'https://github.com/Acme/App/pull/3', conversationId: general } });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.data.map((r) => [r.repo, r.conversationId, r.addedBy]), [['acme/app', general, userId]]);
    assert.deepEqual((await request<ProjectRepoDTO[]>('GET', path, { headers: { cookie: eve.cookie } })).data.map((r) => r.repo), ['acme/app']);
  });

  test('a new pull request in a linked repository waits for its author’s page, with its reviewers', async () => {
    github.state.authored.push(
      { id: 'PR_mine_4', number: 4, title: 'Add sign-up page', author: 'octo', reviewers: ['eve-gh'], teams: ['acme/designers'], hiddenReviewer: true, assignees: ['octo'] },
      { id: 'PR_mine_5', number: 5, title: 'Fix footer', author: 'octo', repo: 'acme/site' },
      { id: 'PR_mine_6', number: 6, title: 'Try dark mode', author: 'octo', draft: true },
    );
    await pollDue();

    const { data } = await request<GithubDTO>('GET', '/github');
    assert.deepEqual(data.shares.map((s) => [s.pull.number, s.conversationId]), [[4, capstone.generalId]], 'not another repository, not a draft');
    assert.deepEqual(data.shares[0]!.pull.reviewers, ['eve-gh', 'acme/designers'], 'a reviewer the token cannot see is left out');
    assert.deepEqual(data.shares[0]!.pull.assignees, ['octo']);
  });

  test('one tab claims a share, a draft is shared once it is ready, and nothing is shared twice', async () => {
    const [share] = (await request<GithubDTO>('GET', '/github')).data.shares;
    const claim = `/github/shares/${share!.id}/claim`;
    assert.equal((await request('POST', claim, { headers: { cookie: eve.cookie } })).status, 409, 'not someone else’s');
    assert.equal((await request('POST', claim)).status, 204);
    const again = await request<{ code?: string }>('POST', claim);
    assert.deepEqual([again.status, again.data.code], [409, 'already_shared']);

    github.state.authored = github.state.authored.map((p) => (p.id === 'PR_mine_6' ? { ...p, draft: false } : p));
    await pollDue();
    assert.deepEqual((await request<GithubDTO>('GET', '/github')).data.shares.map((s) => s.pull.number), [6]);
  });

  test('turning sharing off forgets what waited, and a merged or left behind pull request is not shared', async () => {
    assert.equal((await request('PATCH', '/github', { body: {} })).status, 400);
    assert.equal((await request('PATCH', '/github', { body: { autoShare: 'yes' } })).status, 400);
    const off = await request<GithubDTO>('PATCH', '/github', { body: { autoShare: false } });
    assert.deepEqual([off.data.account!.autoShare, off.data.shares], [false, []]);
    const on = await request<GithubDTO>('PATCH', '/github', { body: { autoShare: true } });
    assert.deepEqual([on.data.account!.autoShare, on.data.shares], [true, []]);

    github.state.authored.push({ id: 'PR_mine_7', number: 7, title: 'Add search', author: 'octo' });
    await pollDue();
    assert.deepEqual((await request<GithubDTO>('GET', '/github')).data.shares.map((s) => s.pull.number), [7]);
    github.state.authored = github.state.authored.filter((p) => p.id !== 'PR_mine_7');
    github.state.endings.set('PR_mine_7', { state: 'MERGED', mergedBy: 'eve-gh' });
    await pollDue();
    assert.deepEqual((await request<GithubDTO>('GET', '/github')).data.shares, [], 'merged before the page posted it');

    github.state.authored.push({ id: 'PR_mine_8', number: 8, title: 'Add filters', author: 'octo' });
    await pollDue();
    const [waiting] = (await request<GithubDTO>('GET', '/github')).data.shares;
    await instance.sql.query('DELETE FROM webchat.members WHERE conversation_id = $1 AND user_id = $2', [capstone.generalId, userId]);
    assert.deepEqual((await request<GithubDTO>('GET', '/github')).data.shares, [], 'not into a channel the author left');
    assert.equal((await request('POST', `/github/shares/${waiting!.id}/claim`)).status, 409);
  });

  test('the scheduler endpoint needs the CRON_SECRET', async () => {
    assert.equal((await request('GET', '/github/poll', { headers: { cookie: '' } })).status, 401);
    assert.equal((await request('GET', '/github/poll', { headers: { cookie: '', authorization: 'Bearer wrong' } })).status, 401);
    await pollDue();
    const ok = await request<{ polled: number }>('GET', '/github/poll', { headers: { cookie: '', authorization: `Bearer ${CRON_SECRET}` } });
    assert.deepEqual([ok.status, ok.data], [200, { polled: 1 }]);
    // Polled a moment ago, so nothing is due.
    const again = await request<{ polled: number }>('GET', '/github/poll', { headers: { cookie: '', authorization: `Bearer ${CRON_SECRET}` } });
    assert.deepEqual(again.data, { polled: 0 });
  });

  test('when GitHub refuses the token, the user is asked to connect again and polling stops', async () => {
    github.state.validToken = 'something-else';
    await pollDue();
    const { data } = await request<GithubDTO>('GET', '/github');
    assert.equal(data.reconnect, true);
    assert.match(data.error!, /Connect GitHub again/);

    const searches = github.state.searches.length;
    await pollDue();
    await request('GET', '/github');
    assert.equal(github.state.searches.length, searches, 'no more polls with a refused token');
    github.state.validToken = TOKEN;
  });

  test('disconnecting deletes the token and revokes the grant on GitHub', async () => {
    const { data } = await request<GithubDTO>('DELETE', '/github');
    assert.equal(data.account, null);
    assert.equal((await instance.sql.query('SELECT 1 FROM webchat.github_accounts')).length, 0);
    assert.equal((await instance.sql.query('SELECT 1 FROM webchat.github_events')).length, 0);
    assert.deepEqual(github.state.revoked, [
      {
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
        body: { access_token: TOKEN },
      },
    ]);
  });
});

describe('comparing two polls', () => {
  const pull = (overrides: Partial<PullRequestDTO>): PullRequestDTO => ({
    id: 'PR_1',
    repo: 'acme/app',
    number: 1,
    title: 'Add login page',
    url: 'https://github.com/acme/app/pull/1',
    author: 'octo',
    draft: false,
    review: null,
    checks: null,
    conflicts: false,
    comments: 0,
    lastCommenter: null,
    additions: 1,
    deletions: 0,
    updatedAt: 0,
    ...overrides,
  });
  const lists = (authored: PullRequestDTO[], reviewRequested: PullRequestDTO[] = []): PullListsDTO => ({ authored, reviewRequested });

  test('checks passing after a failure, and new conflicts, are reported once', () => {
    const before = lists([pull({ checks: 'failure' })]);
    const after = lists([pull({ checks: 'success', conflicts: true })]);
    assert.deepEqual(comparePulls(before, after, 'octo').events.map((e) => e.kind), ['checks_passed', 'conflicts']);
    assert.deepEqual(comparePulls(after, after, 'octo').events, []);
  });

  test('checks that appear and pass between polls are not news, and a new pull request of one’s own is not either', () => {
    const before = lists([pull({ checks: null })]);
    const after = lists([pull({ checks: 'success' }), pull({ id: 'PR_2', number: 2 })]);
    assert.deepEqual(comparePulls(before, after, 'octo').events, []);
  });

  test('pull requests that leave the open list are handed back to look up', () => {
    const before = lists([pull({}), pull({ id: 'PR_2', number: 2 })]);
    assert.deepEqual(comparePulls(before, lists([pull({})]), 'octo').left.map((p) => p.id), ['PR_2']);
  });

  test('one’s own pull requests that open ready, or leave draft, are handed back for linked projects', () => {
    const before = lists([pull({}), pull({ id: 'PR_2', number: 2, draft: true }), pull({ id: 'PR_3', number: 3, draft: true })]);
    const after = lists([
      pull({}),
      pull({ id: 'PR_2', number: 2 }),
      pull({ id: 'PR_3', number: 3, draft: true }),
      pull({ id: 'PR_4', number: 4 }),
      pull({ id: 'PR_5', number: 5, draft: true }),
    ]);
    assert.deepEqual(comparePulls(before, after, 'octo').ready.map((p) => p.id), ['PR_2', 'PR_4']);
  });
});
