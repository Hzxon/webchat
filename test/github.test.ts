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
import type {
  BootstrapDTO,
  GithubCardDTO,
  GithubDTO,
  MessageDTO,
  ProjectReposDTO,
  PullListsDTO,
  PullRequestDTO,
  PushPayload,
} from '../shared/types.ts';

const CLIENT_ID = 'Iv1.test-client';
const CLIENT_SECRET = 'test-client-secret';
const CRON_SECRET = 'test-cron-secret';
const TOKEN = 'gho_test_access_token';
const APP_SLUG = 'webchat-test';
const APP_CLIENT_ID = 'Iv23.test-app';
const APP_CLIENT_SECRET = 'test-app-secret';
const APP_TOKEN = 'ghu_test_app_token';
const WEBHOOK_SECRET = 'test-webhook-secret';

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
  /** Requested reviewers: people by login. */
  reviewers?: string[];
  /** Teams asked to review. Without a Team fragment in the query, GitHub sends each as an empty object. */
  teams?: string[];
  /** A requested reviewer the token cannot see, which GitHub answers with null. */
  hiddenReviewer?: boolean;
  assignees?: string[];
}

/**
 * Stands in for github.com and api.github.com: OAuth, the user, GraphQL search, and grant deletion
 * for the OAuth App; the sign-in, installations and token deletion for the GitHub App.
 */
async function startFakeGithub() {
  const state = {
    appChallenge: '',
    /** The GitHub App's installations the signed-in owner reaches, with their repositories. */
    installations: [
      {
        id: 77,
        repos: [
          { id: 9001, full_name: 'Acme/App' },
          { id: 9002, full_name: 'acme/site' },
        ],
      },
    ],
    appRevoked: [] as string[],
    /** The token GitHub accepts; set to something else to act as if the user revoked access. */
    validToken: TOKEN,
    challenge: '',
    reviewRequested: [] as FakePull[],
    authored: [] as FakePull[],
    /** Organizations that restrict OAuth Apps: GitHub leaves their pull requests out and adds an error for each. */
    restricted: [] as string[],
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
        ...(p.teams ?? []).map(() => ({ requestedReviewer: {} })),
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
      const path = new URL(req.url ?? '/', 'http://github.test').pathname;

      if (req.method === 'POST' && req.url === '/login/oauth/access_token' && body.client_id === APP_CLIENT_ID) {
        const verifierOk = crypto.createHash('sha256').update(String(body.code_verifier)).digest('base64url') === state.appChallenge;
        if (body.client_secret !== APP_CLIENT_SECRET) return json(200, { error: 'incorrect_client_credentials' });
        if (body.code !== 'app-code' || !verifierOk) return json(200, { error: 'bad_verification_code' });
        return json(200, { access_token: APP_TOKEN, token_type: 'bearer' });
      }
      if (req.method === 'GET' && path.startsWith('/user/installations')) {
        if (req.headers.authorization !== `Bearer ${APP_TOKEN}`) return json(401, { message: 'Bad credentials' });
        const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
        if (!repos) return json(200, { total_count: state.installations.length, installations: state.installations.map(({ id }) => ({ id })) });
        const installation = state.installations.find((i) => i.id === Number(repos[1]));
        return installation ? json(200, { total_count: installation.repos.length, repositories: installation.repos }) : json(404, {});
      }
      if (req.method === 'DELETE' && req.url === `/applications/${APP_CLIENT_ID}/token`) {
        const basic = `Basic ${Buffer.from(`${APP_CLIENT_ID}:${APP_CLIENT_SECRET}`).toString('base64')}`;
        if (req.headers.authorization !== basic) return json(401, {});
        state.appRevoked.push(String(body.access_token));
        return res.writeHead(204).end();
      }

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
        // GitHub checks the scopes a query needs before it runs it, and refuses all of it.
        if (/\bon Team\b/.test(query)) {
          return json(200, {
            errors: [{ type: 'INSUFFICIENT_SCOPES', message: "The 'combinedSlug' field requires one of the following scopes: ['read:org']" }],
          });
        }
        if (query.includes('query Pulls')) {
          state.searches.push(body.variables.reviewQuery, body.variables.authoredQuery);
          // A pull request in a restricted organization comes back as a null node, with a
          // FORBIDDEN error next to the data that names the organization.
          const errors: unknown[] = [];
          const nodes = (list: FakePull[], name: string) =>
            list.map((p, index) => {
              const owner = (p.repo ?? 'acme/app').split('/')[0]!;
              if (!state.restricted.includes(owner)) return toNode(p);
              errors.push({
                type: 'FORBIDDEN',
                path: [name, 'nodes', index],
                extensions: { saml_failure: false },
                locations: [{ line: 4, column: 3 }],
                message: `Although you appear to have the correct authorization credentials, the \`${owner}\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these restrictions, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/`,
              });
              return null;
            });
          const data = {
            viewer: { login: 'octo' },
            reviewRequested: { nodes: nodes(state.reviewRequested, 'reviewRequested') },
            authored: { nodes: nodes(state.authored, 'authored') },
          };
          return json(200, errors.length > 0 ? { data, errors } : { data });
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
  let config: Config;

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
    config = {
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
      barkApnsKey: undefined,
      barkApnsKeyId: 'LH4T9V5U4R',
      barkApnsTeamId: '5U8LBRXG3A',
      apnsOrigin: 'https://api.push.apple.com',
      clientDir: null,
      githubClientId: CLIENT_ID,
      githubClientSecret: CLIENT_SECRET,
      githubCallbackUrl: undefined,
      githubAppSlug: APP_SLUG,
      githubAppClientId: APP_CLIENT_ID,
      githubAppClientSecret: APP_CLIENT_SECRET,
      githubWebhookSecret: WEBHOOK_SECRET,
      githubAppCallbackUrl: undefined,
      githubOauthUrl: github.url,
      githubApiUrl: github.url,
      githubPollSeconds: 0,
      cronSecret: CRON_SECRET,
      githubPollUrl: undefined,
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
    assert.deepEqual(data.account, { login: 'octo', name: 'Octo Cat', notify: true });
    assert.equal(data.appConfigured, true, 'projects can link repositories, so the page shows the button');
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
    assert.equal((await request('PATCH', '/github', { body: {} })).status, 400);
    assert.equal((await request('PATCH', '/github', { body: { notify: 'no' } })).status, 400);
    assert.equal((await request<GithubDTO>('PATCH', '/github', { body: { notify: false } })).data.account!.notify, false);
    pushService.received.length = 0;
    github.state.authored[1] = { ...github.state.authored[1]!, comments: 3, lastCommenter: 'bob' };
    await pollDue();

    const { data } = await request<GithubDTO>('GET', '/github');
    assert.deepEqual([data.events[0]!.kind, data.events[0]!.actor], ['commented', 'bob']);
    await sleep(200);
    assert.equal(pushService.received.length, 0);
  });

  test('the poll never asks for teams, which need read:org, and leaves a team asked to review out', async () => {
    github.state.authored.push({
      id: 'PR_mine_4',
      number: 4,
      title: 'Add sign-up page',
      author: 'octo',
      reviewers: ['eve-gh'],
      teams: ['acme/designers'],
      hiddenReviewer: true,
      assignees: ['octo'],
    });
    await pollDue();
    const { data } = await request<GithubDTO>('GET', '/github');
    assert.equal(data.error, null);
    const pull = data.pulls!.authored.find((p) => p.number === 4)!;
    assert.deepEqual([pull.reviewers, pull.assignees], [['eve-gh'], ['octo']]);
  });

  test('an organization that restricts OAuth Apps is named, and its pull requests are left out (K-6)', async () => {
    github.state.restricted = ['classroom'];
    github.state.authored.push({ id: 'PR_hw_1', number: 1, title: 'Homework 1', author: 'octo', repo: 'classroom/hw1' });
    github.state.reviewRequested.push({ id: 'PR_hw_2', number: 2, title: 'Homework 2', author: 'alice', repo: 'classroom/hw1' });
    await pollDue();
    let { data } = await request<GithubDTO>('GET', '/github');
    assert.equal(data.error, null, 'the rest of the answer is still shown');
    assert.deepEqual(data.pulls!.hiddenOrganizations, ['classroom'], 'named once, however many pull requests it hides');
    assert.ok(!JSON.stringify(data.pulls).includes('Homework'), 'GitHub left them out, and nothing invents them');
    assert.ok(data.pulls!.authored.some((p) => p.number === 4), 'pull requests from elsewhere still show');

    // An owner approved the app: the pull requests appear, and the note goes away.
    github.state.restricted = [];
    await pollDue();
    ({ data } = await request<GithubDTO>('GET', '/github'));
    assert.deepEqual(data.pulls!.hiddenOrganizations, []);
    assert.ok(data.pulls!.authored.some((p) => p.repo === 'classroom/hw1'));
    github.state.authored = github.state.authored.filter((p) => p.repo !== 'classroom/hw1');
    github.state.reviewRequested = github.state.reviewRequested.filter((p) => p.repo !== 'classroom/hw1');
    await pollDue();
    await request('GET', '/github');
  });

  let eve: Awaited<ReturnType<typeof addUser>>;
  let finn: Awaited<ReturnType<typeof addUser>>;
  let capstone: Awaited<ReturnType<typeof addProject>>;
  const reposPath = () => `/projects/${capstone.projectId}/repos`;

  /** Signs in to the GitHub App as the project's owner, and comes back the way GitHub sends them. */
  async function signInToApp(state?: string) {
    const { res } = await request('GET', `/github/app/link?project=${capstone.projectId}`);
    const authorize = new URL(res.headers.get('location')!);
    github.state.appChallenge = authorize.searchParams.get('code_challenge')!;
    const stateCookie = res.headers.get('set-cookie')!.split(';')[0]!;
    return request('GET', `/github/app/callback?code=app-code&state=${state ?? authorize.searchParams.get('state')}`, {
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
  }

  /** Sends a webhook the way GitHub signs it. */
  async function webhook(event: string, payload: unknown, options: { delivery?: string; secret?: string } = {}) {
    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(body).digest('hex');
    const res = await fetch(`${baseUrl}/api/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': options.delivery ?? crypto.randomUUID(),
        'x-hub-signature-256': `sha256=${signature}`,
      },
      body,
    });
    return res.status;
  }

  const appRepo = { id: 9001, full_name: 'Acme/App' };
  const pullEvent = (action: string, pull: Record<string, unknown> = {}, repository: object = appRepo) => ({
    action,
    pull_request: {
      number: 12,
      title: 'Add sign-up page',
      draft: false,
      merged: false,
      user: { login: 'octo' },
      merged_by: null,
      requested_reviewers: [{ login: 'eve-gh' }],
      requested_teams: [{ slug: 'designers' }],
      assignees: [{ login: 'octo' }],
      ...pull,
    },
    repository,
    sender: { login: 'octo' },
    installation: { id: 77 },
  });

  const githubCards = async () =>
    (await instance.sql.query<{ body: string }>("SELECT body FROM webchat.messages WHERE kind = 'github' ORDER BY id")).map(
      (row) => JSON.parse(row.body) as GithubCardDTO,
    );

  test('only a project’s owner starts linking, through the GitHub App’s own sign-in', async () => {
    eve = await addUser('eve', 'Eve');
    finn = await addUser('finn', 'Finn');
    capstone = await addProject('Capstone', [userId, eve.id]);

    const asEve = await request('GET', `/github/app/link?project=${capstone.projectId}`, { headers: { cookie: eve.cookie } });
    assert.equal(asEve.res.headers.get('location'), '/?github=repos-error');
    const { res } = await request('GET', `/github/app/link?project=${capstone.projectId}`);
    assert.equal(res.status, 303);
    const authorize = new URL(res.headers.get('location')!);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${github.url}/login/oauth/authorize`);
    assert.equal(authorize.searchParams.get('client_id'), APP_CLIENT_ID);
    assert.equal(authorize.searchParams.get('scope'), null, 'a GitHub App asks for no scopes');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${baseUrl}/api/github/app/callback`);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

    // Installing goes through GitHub's page, which sends the browser to the Setup URL afterwards.
    const install = await request('GET', `/github/app/install?project=${capstone.projectId}`);
    assert.equal(install.res.headers.get('location'), `${github.url}/apps/${APP_SLUG}/installations/new`);
    const installCookie = install.res.headers.get('set-cookie')!.split(';')[0]!;
    const setup = await request('GET', '/github/app/setup?installation_id=77&setup_action=install', {
      headers: { cookie: `${cookie}; ${installCookie}` },
    });
    assert.equal(setup.res.headers.get('location'), `/api/github/app/link?project=${capstone.projectId}`);
    const setupAsEve = await request('GET', '/github/app/setup', { headers: { cookie: `${eve.cookie}; ${installCookie}` } });
    assert.equal(setupAsEve.res.headers.get('location'), '/');
  });

  test('the app sign-in lists what the owner reaches, keeps no token, and only that can be linked', async () => {
    const forged = await signInToApp('attacker');
    assert.equal(forged.res.headers.get('location'), `/?github=repos-error&project=${capstone.projectId}`);

    const back = await signInToApp();
    assert.equal(back.res.headers.get('location'), `/?github=repos&project=${capstone.projectId}`);
    assert.deepEqual(github.state.appRevoked, [APP_TOKEN], 'the token is revoked once the repositories are listed');

    const view = await request<ProjectReposDTO>('GET', reposPath());
    assert.deepEqual(view.data, {
      configured: true,
      repos: [],
      choices: [
        { repoId: 9001, repo: 'Acme/App' },
        { repoId: 9002, repo: 'acme/site' },
      ],
    });
    const eveView = await request<ProjectReposDTO>('GET', reposPath(), { headers: { cookie: eve.cookie } });
    assert.deepEqual(eveView.data.choices, [], 'only the owner gets choices');
    assert.equal((await request('GET', reposPath(), { headers: { cookie: finn.cookie } })).status, 404, 'outsiders see nothing');

    const general = capstone.generalId;
    const asEve = await request<{ code?: string }>('POST', reposPath(), {
      headers: { cookie: eve.cookie },
      body: { repoId: 9001, conversationId: general },
    });
    assert.deepEqual([asEve.status, asEve.data.code], [403, 'not_owner']);
    const unseen = await request<{ code?: string }>('POST', reposPath(), { body: { repoId: 1234, conversationId: general } });
    assert.deepEqual([unseen.status, unseen.data.code], [409, 'no_grant'], 'not one the owner did not show GitHub they reach');
    assert.equal((await request('POST', reposPath(), { body: { repoId: 9001, conversationId: 999_999 } })).status, 400);

    const linked = await request<ProjectReposDTO>('POST', reposPath(), { body: { repoId: 9001, conversationId: general } });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.data.repos.map((r) => [r.repoId, r.repo, r.conversationId, r.addedBy]), [[9001, 'Acme/App', general, userId]]);
    assert.deepEqual(linked.data.choices.map((c) => c.repoId), [9002]);
  });

  test('a signed webhook posts a card into the linked channel, and pushes it to every member', async () => {
    const evePhone = makeSubscription(`http://${pushService.host}/eve-phone`);
    assert.equal((await request('POST', '/push/subscribe', { headers: { cookie: eve.cookie }, body: evePhone.json })).status, 204);
    pushService.received.length = 0;

    assert.equal(await webhook('pull_request', pullEvent('opened')), 202);
    const { data } = await request<MessageDTO[]>('GET', `/conversations/${capstone.generalId}/messages`, { headers: { cookie: eve.cookie } });
    const card = data.at(-1)!;
    assert.deepEqual([card.kind, card.senderId, card.envelope, card.clientId], ['github', null, null, null]);
    assert.deepEqual(JSON.parse(card.body), {
      event: 'opened',
      pull: {
        repo: 'Acme/App',
        number: 12,
        title: 'Add sign-up page',
        url: 'https://github.com/Acme/App/pull/12',
        draft: false,
        review: null,
        checks: null,
        conflicts: false,
        reviewers: ['eve-gh'],
        assignees: ['octo'],
      },
      author: 'octo',
      actor: null,
    });
    for (const member of [cookie, eve.cookie]) {
      const boot = await request<BootstrapDTO>('GET', '/bootstrap', { headers: { cookie: member } });
      const general = boot.data.conversations.find((c) => c.id === capstone.generalId)!;
      assert.deepEqual([general.unread, general.lastMessage?.id], [1, card.id], 'it counts as unread for everyone, like a message');
    }

    // Dana's phone and Eve's both get it.
    const deadline = Date.now() + 3000;
    while (pushService.received.length < 2 && Date.now() < deadline) await sleep(20);
    const forEve = pushService.received.flatMap((body) => {
      try {
        return [evePhone.decrypt(body)];
      } catch {
        return [];
      }
    });
    assert.equal(forEve.length, 1);
    assert.deepEqual(
      [forEve[0]!.kind, forEve[0]!.title, forEve[0]!.body, forEve[0]!.senderId, forEve[0]!.conversationId, forEve[0]!.messageId],
      ['message', '#general · Capstone', 'GitHub: octo opened a pull request: Add sign-up page (Acme/App#12)', null, capstone.generalId, card.id],
    );
  });

  test('a delivery sent again posts once; a bad signature, an unlinked repository or a quiet action posts nothing', async () => {
    const before = (await githubCards()).length;
    const delivery = crypto.randomUUID();
    assert.equal(await webhook('pull_request', pullEvent('ready_for_review', { number: 13 }), { delivery }), 202);
    assert.equal(await webhook('pull_request', pullEvent('ready_for_review', { number: 13 }), { delivery }), 202);
    assert.equal(await webhook('pull_request', pullEvent('opened'), { secret: 'not-the-secret' }), 401);
    assert.equal(await webhook('pull_request', pullEvent('opened', {}, { id: 5555, full_name: 'acme/other' })), 202);
    for (const quiet of ['synchronize', 'edited', 'labeled', 'review_requested', 'converted_to_draft']) {
      assert.equal(await webhook('pull_request', pullEvent(quiet)), 202);
    }
    const cards = await githubCards();
    assert.equal(cards.length, before + 1);
    assert.deepEqual([cards.at(-1)!.event, cards.at(-1)!.actor, cards.at(-1)!.pull.number], ['ready', 'octo', 13]);
  });

  test('a merge names who merged it, and a renamed repository keeps its link', async () => {
    const renamed = { id: 9001, full_name: 'acme/webapp' };
    await webhook('pull_request', {
      ...pullEvent('closed', { merged: true, merged_by: { login: 'eve-gh' } }, renamed),
      sender: { login: 'hubot' },
    });
    await webhook('pull_request', pullEvent('closed', { number: 13 }, renamed));
    const [merged, closed] = (await githubCards()).slice(-2);
    assert.deepEqual([merged!.event, merged!.actor, merged!.pull.repo], ['merged', 'eve-gh', 'acme/webapp']);
    assert.deepEqual([closed!.event, closed!.actor], ['closed', 'octo']);
    assert.deepEqual((await request<ProjectReposDTO>('GET', reposPath())).data.repos.map((r) => r.repo), ['acme/webapp']);
  });

  test('the owner unlinks, and taking the app off a repository or uninstalling it unlinks too', async () => {
    const general = capstone.generalId;
    await request('POST', reposPath(), { body: { repoId: 9002, conversationId: general } });
    assert.equal((await request('DELETE', `${reposPath()}/9002`, { headers: { cookie: eve.cookie } })).status, 403);
    const unlinked = await request<ProjectReposDTO>('DELETE', `${reposPath()}/9002`);
    assert.deepEqual(unlinked.data.repos.map((r) => r.repoId), [9001]);

    await request('POST', reposPath(), { body: { repoId: 9002, conversationId: general } });
    await webhook('installation_repositories', { action: 'removed', installation: { id: 77 }, repositories_removed: [{ id: 9002 }] });
    const afterRemoval = (await request<ProjectReposDTO>('GET', reposPath())).data;
    assert.deepEqual([afterRemoval.repos.map((r) => r.repoId), afterRemoval.choices.map((c) => c.repoId)], [[9001], []]);

    await webhook('installation', { action: 'deleted', installation: { id: 77 } });
    assert.deepEqual((await request<ProjectReposDTO>('GET', reposPath())).data.repos, []);
    const before = (await githubCards()).length;
    await webhook('pull_request', pullEvent('opened', { number: 14 }));
    assert.equal((await githubCards()).length, before, 'nothing links the repository any more');
  });

  test('a choice expires, and linking needs a new sign-in to the app', async () => {
    await signInToApp();
    await instance.sql.query('UPDATE webchat.github_app_grants SET expires_at = 0');
    const stale = await request<{ code?: string }>('POST', reposPath(), { body: { repoId: 9001, conversationId: capstone.generalId } });
    assert.deepEqual([stale.status, stale.data.code], [409, 'no_grant']);
    assert.deepEqual((await request<ProjectReposDTO>('GET', reposPath())).data.choices, []);
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

  test('the pane promises alerts with every tab closed only while a scheduler polls (K-5)', async () => {
    const closedTabAlerts = async (as = cookie) =>
      (await request<GithubDTO>('GET', '/github', { headers: { cookie: as } })).data.alertsWhileClosed;
    await instance.sql.query("DELETE FROM webchat.meta WHERE key = 'github_scheduled_at'");
    assert.equal(await closedTabAlerts(), false, 'nothing has ever polled on a schedule');

    // A tab's own poll stops when the tab closes, so it does not count.
    const searches = github.state.searches.length;
    await pollDue();
    await request('GET', '/github?refresh=1');
    assert.ok(github.state.searches.length > searches, 'the tab did poll GitHub');
    assert.equal(await closedTabAlerts(), false);
    await request('GET', '/github/poll', { headers: { cookie: '', authorization: 'Bearer wrong' } });
    assert.equal(await closedTabAlerts(), false, 'a refused call is not a scheduler');

    await request('GET', '/github/poll', { headers: { cookie: '', authorization: `Bearer ${CRON_SECRET}` } });
    assert.equal(await closedTabAlerts(), true);
    const { cookie: stranger } = await addUser('gwen', 'Gwen');
    assert.equal(await closedTabAlerts(stranger), true, 'the connect card sees it too');

    await instance.sql.query("UPDATE webchat.meta SET value = $1 WHERE key = 'github_scheduled_at'", [String(Date.now() - 11 * 60_000)]);
    assert.equal(await closedTabAlerts(), false, 'a scheduler that stopped 11 minutes ago no longer counts');
    assert.equal(await closedTabAlerts(stranger), false);
  });

  test('the scheduler endpoint also accepts the secret of the database’s own job', async () => {
    await instance.sql.query(
      "INSERT INTO webchat.meta (key, value) VALUES ('github_poll_secret', 'job-secret') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    );
    try {
      const job = (authorization: string) => request('GET', '/github/poll', { headers: { cookie: '', authorization } });
      assert.equal((await job('Bearer job-secret')).status, 200);
      assert.equal((await job('Bearer job-secre')).status, 401);
      assert.equal((await job('job-secret')).status, 401);
    } finally {
      await instance.sql.query("DELETE FROM webchat.meta WHERE key = 'github_poll_secret'");
    }
  });

  test('without pg_cron the app still starts, keeps no job secret, and logs why', async () => {
    const warnings: string[] = [];
    const other = await createApp({
      ...config,
      githubPollUrl: 'https://webchat.example/api/github/poll',
      logger: { ...config.logger, warn: (message) => warnings.push(message) },
    });
    try {
      assert.match(warnings.join('\n'), /Could not schedule GitHub polls in the database/);
      assert.deepEqual(await other.sql.query("SELECT key FROM webchat.meta WHERE key = 'github_poll_secret'"), []);
    } finally {
      await other.close();
    }
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
});
