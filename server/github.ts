// GitHub connector: links a GitHub account through an OAuth App, watches the user's open pull
// requests for their Pull requests pane, and turns changes into alerts. Projects link repositories
// through the GitHub App instead (githubApp.ts).
//
// The server holds the token, never the browser, because polls run on the server: that is how a
// pull request alert reaches a phone while every tab is closed. The token is stored encrypted with
// a key derived from the OAuth App's client secret, which lives only in the environment, so a copy
// of the database alone cannot use it.
import crypto from 'node:crypto';
import { describeGithubEvent } from '../shared/github.js';
import {
  LIMITS,
  showsEveryPush,
  type BranchChoiceDTO,
  type GithubDTO,
  type OpenPullInput,
  type GithubEventDTO,
  type GithubEventKind,
  type PullChecks,
  type PullListsDTO,
  type PullRequestDTO,
  type PullReview,
  type PushPayload,
} from '../shared/types.js';
import { safeEqual } from './auth.js';
import type { Config } from './config.js';
import { GITHUB_POLL_JOB, isAttentive, type Db } from './db.js';
import type { Push } from './push.js';

/** Lets the token read pull requests in private repositories too. OAuth Apps have no read-only scope for that. */
const SCOPE = 'repo';
/** However many tabs and schedulers ask, one account is polled at most this often. */
export const POLL_INTERVAL_MS = 60_000;
/** The refresh button may poll sooner. */
const MANUAL_POLL_INTERVAL_MS = 10_000;
/** Scheduled runs poll accounts slightly early, so a run that starts a moment soon does not skip one. */
const SCHEDULED_POLL_INTERVAL_MS = POLL_INTERVAL_MS - 5_000;
const PULLS_PER_LIST = 30;
/** The All view searches at most this many linked repositories, to keep the search query short. */
const TEAM_REPOS = 10;
/** The Open a pull request dialog looks at this many repositories, and this many newest branches of each. */
const BRANCH_REPOS = 6;
const BRANCHES_PER_REPO = 20;
/** More changes than this in one poll still show in the activity list, but only the newest are pushed. */
const MAX_PUSHES_PER_POLL = 3;
/**
 * Least important first. One poll's events are stored in this order, so when it finds more changes
 * than get pushed or fit in the page's toasts, the ones kept are those that need the user most.
 */
const IMPORTANCE: GithubEventKind[] = [
  'closed',
  'checks_passed',
  'commented',
  'merged',
  'approved',
  'conflicts',
  'checks_failed',
  'changes_requested',
  'review_requested',
];
/** Accounts polled at the same time by a scheduled run. */
const POLL_CONCURRENCY = 4;
/**
 * Alerts reach a phone with every tab closed only while a timer or a scheduler runs pollAll. After
 * this long without a run, five missed runs of a 2-minute clock, the pane says alerts need an open tab.
 */
const SCHEDULED_POLL_STALE_MS = 10 * 60_000;
const REST_API_VERSION = '2022-11-28';

/** A failure to show the user. revoked means GitHub refused the token, so they must connect again. */
export class GithubError extends Error {
  revoked: boolean;
  constructor(message: string, revoked = false) {
    super(message);
    this.revoked = revoked;
  }
}

/** The fields of one pull request that the poll asks GitHub for. */
const PULL_FIELDS = `
fragment Pull on PullRequest {
  id
  number
  title
  url
  isDraft
  updatedAt
  mergedAt
  closed
  headRefName
  additions
  deletions
  reviewDecision
  mergeable
  repository { nameWithOwner }
  author { login }
  comments(last: 1) { totalCount nodes { author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: ${LIMITS.pullPeople}) {
    nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } } }
  }
  assignees(first: ${LIMITS.pullPeople}) { nodes { login } }
  latestReviews(first: ${LIMITS.pullPeople}) { nodes { state author { login } } }
}`;

const PULLS_QUERY = `
query Pulls($reviewQuery: String!, $authoredQuery: String!, $mergedQuery: String!, $teamQuery: String!, $team: Boolean!, $first: Int!) {
  viewer { login }
  reviewRequested: search(type: ISSUE, query: $reviewQuery, first: $first) { nodes { ...Pull } }
  authored: search(type: ISSUE, query: $authoredQuery, first: $first) { nodes { ...Pull } }
  merged: search(type: ISSUE, query: $mergedQuery, first: $first) { nodes { ...Pull } }
  team: search(type: ISSUE, query: $teamQuery, first: $first) @include(if: $team) { nodes { ...Pull } }
}
${PULL_FIELDS}`;

/**
 * The newest branches of each repository, with whether a pull request was ever opened from them.
 * The repositories come in as aliases, since GraphQL takes no list of them.
 */
const branchesQuery = (count: number) => `
query Branches(${Array.from({ length: count }, (_, i) => `$o${i}: String!, $n${i}: String!`).join(', ')}) {
${Array.from(
  { length: count },
  (_, i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) {
    nameWithOwner
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: ${BRANCHES_PER_REPO}, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes {
        name
        associatedPullRequests(first: 1) { totalCount }
        target { ... on Commit { messageHeadline committedDate } }
      }
    }
  }`,
).join('\n')}
}`;

interface BranchesRepo {
  nameWithOwner: string;
  defaultBranchRef: { name: string } | null;
  refs: {
    nodes: Array<{
      name: string;
      associatedPullRequests: { totalCount: number };
      target: { messageHeadline?: string; committedDate?: string } | null;
    } | null> | null;
  } | null;
}

/** Finds out what happened to pull requests that left the open list. */
const STATES_QUERY = `
query States($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id state mergedBy { login } } }
}`;

interface PullNode {
  id?: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  mergedAt: string | null;
  closed: boolean;
  headRefName: string;
  additions: number;
  deletions: number;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  repository: { nameWithOwner: string };
  author: { login: string } | null;
  comments: { totalCount: number; nodes: Array<{ author: { login: string } | null } | null> | null };
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } } | null> | null };
  /**
   * A reviewer is null when the token cannot see it. A team comes back empty: any field of a team
   * needs the read:org scope, and asking for one makes GitHub refuse the whole query.
   */
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string } | null } | null> | null;
  } | null;
  assignees: { nodes: Array<{ login: string } | null> | null } | null;
  latestReviews: { nodes: Array<{ state: string; author: { login: string } | null } | null> | null } | null;
}

interface PullsResult {
  viewer: { login: string };
  reviewRequested: { nodes: Array<PullNode | null> | null } | null;
  authored: { nodes: Array<PullNode | null> | null } | null;
  merged: { nodes: Array<PullNode | null> | null } | null;
  team?: { nodes: Array<PullNode | null> | null } | null;
}

interface StatesResult {
  nodes: Array<{ id?: string; state?: 'OPEN' | 'CLOSED' | 'MERGED'; mergedBy?: { login: string } | null } | null>;
}

/** One entry of the errors GitHub's GraphQL API sends next to the data it could still answer. */
interface GraphqlError {
  type?: string;
  message: string;
}

/**
 * GitHub names an organization that restricts OAuth Apps in the error it adds for each of its
 * pull requests it left out. Nothing else in the answer says they exist.
 */
const RESTRICTED_ORGANIZATION = /the `([^`]+)` organization has enabled OAuth App access restrictions/g;

/**
 * The organizations whose pull requests GitHub left out of an answer because they restrict OAuth
 * Apps and no owner has approved WebChat yet (K-6). Each is named once, in the order found.
 */
export function hiddenOrganizations(errors: GraphqlError[]): string[] {
  const names = new Set<string>();
  for (const error of errors) {
    for (const match of error.message.matchAll(RESTRICTED_ORGANIZATION)) names.add(match[1]!);
  }
  return [...names];
}

const REVIEW: Record<NonNullable<PullNode['reviewDecision']>, PullReview> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

function checksOf(state: string | undefined): PullChecks {
  if (state === 'SUCCESS') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return null;
}

/** Turns GitHub's answer into the app's shape. Search results that are not pull requests come back empty and are dropped. */
function toPulls(list: { nodes: Array<PullNode | null> | null } | null): PullRequestDTO[] {
  return (list?.nodes ?? []).flatMap((node) => {
    if (!node?.id) return [];
    return [
      {
        id: node.id,
        repo: node.repository.nameWithOwner,
        number: node.number,
        title: node.title,
        url: node.url,
        author: node.author?.login ?? null,
        draft: node.isDraft,
        review: node.reviewDecision ? REVIEW[node.reviewDecision] : null,
        checks: checksOf(node.commits.nodes?.[0]?.commit.statusCheckRollup?.state),
        conflicts: node.mergeable === 'CONFLICTING',
        comments: node.comments.totalCount,
        lastCommenter: node.comments.nodes?.[0]?.author?.login ?? null,
        additions: node.additions,
        deletions: node.deletions,
        updatedAt: Date.parse(node.updatedAt),
        reviewers: (node.reviewRequests?.nodes ?? []).flatMap((request) => {
          const name = request?.requestedReviewer?.login;
          return name ? [name] : [];
        }),
        assignees: (node.assignees?.nodes ?? []).flatMap((user) => (user ? [user.login] : [])),
        approvedBy: (node.latestReviews?.nodes ?? []).flatMap((review) =>
          review?.state === 'APPROVED' && review.author ? [review.author.login] : [],
        ),
        branch: node.headRefName,
        mergedAt: node.mergedAt ? Date.parse(node.mergedAt) : null,
        closed: node.closed,
      },
    ];
  });
}

export type NewGithubEvent = Omit<GithubEventDTO, 'id' | 'createdAt'>;

const eventFor = (pull: PullRequestDTO, kind: NewGithubEvent['kind'], actor: string | null = null): NewGithubEvent => ({
  kind,
  repo: pull.repo,
  number: pull.number,
  title: pull.title,
  url: pull.url,
  actor,
});

/**
 * Compares two polls. Returns the changes worth an alert, and the pull requests that left the open
 * list (merged, closed, or no longer found), whose fate needs one more question.
 */
export function comparePulls(before: PullListsDTO, after: PullListsDTO, login: string) {
  const events: NewGithubEvent[] = [];
  const waitingBefore = new Set(before.reviewRequested.map((p) => p.id));
  for (const pull of after.reviewRequested) {
    if (!waitingBefore.has(pull.id)) events.push(eventFor(pull, 'review_requested', pull.author));
  }

  const mineBefore = new Map(before.authored.map((p) => [p.id, p]));
  for (const pull of after.authored) {
    const old = mineBefore.get(pull.id);
    if (!old) continue;
    if (pull.review !== old.review && (pull.review === 'approved' || pull.review === 'changes_requested')) {
      events.push(eventFor(pull, pull.review));
    }
    if (pull.checks === 'failure' && old.checks !== 'failure') events.push(eventFor(pull, 'checks_failed'));
    if (pull.checks === 'success' && (old.checks === 'pending' || old.checks === 'failure')) {
      events.push(eventFor(pull, 'checks_passed'));
    }
    if (pull.conflicts && !old.conflicts) events.push(eventFor(pull, 'conflicts'));
    if (pull.comments > old.comments && pull.lastCommenter && pull.lastCommenter.toLowerCase() !== login.toLowerCase()) {
      events.push(eventFor(pull, 'commented', pull.lastCommenter));
    }
  }

  const stillOpen = new Set(after.authored.map((p) => p.id));
  const left = before.authored.filter((p) => !stillOpen.has(p.id));
  return { events, left };
}

/** AES-256-GCM, bound to the account it belongs to so a token cannot be moved to another row. */
function tokenCipher(clientSecret: string) {
  const key = Buffer.from(crypto.hkdfSync('sha256', clientSecret, 'webchat', 'github token v1', 32));
  return {
    seal(token: string, userId: number): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(String(userId)));
      const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return ['v1', iv.toString('base64url'), data.toString('base64url')].join('.');
    },
    /** Null when the token was sealed with another client secret, or altered. */
    open(sealed: string, userId: number): string | null {
      const [version, iv, data] = sealed.split('.');
      if (version !== 'v1' || !iv || !data) return null;
      try {
        const bytes = Buffer.from(data, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(String(userId)));
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

export type Github = ReturnType<typeof createGithub>;

export function createGithub(db: Db, push: Push, config: Config) {
  const { githubClientId: clientId, githubClientSecret: clientSecret } = config;
  const configured = Boolean(clientId && clientSecret);
  const tokens = clientSecret ? tokenCipher(clientSecret) : null;

  /** The user's account and token, for a request they make themselves. */
  async function tokenOf(userId: number) {
    const account = tokens ? await db.githubAccount(userId) : undefined;
    const token = account && tokens!.open(account.token, userId);
    if (!token) throw new GithubError('Connect GitHub first.');
    return { account: account!, token };
  }

  async function rest<T>(token: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.githubApiUrl}${path}`, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'WebChat',
        'x-github-api-version': REST_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) throw new GithubError('GitHub no longer accepts this connection. Connect GitHub again.', true);
    if (res.status >= 400 && res.status < 500) {
      // GitHub says why it refused, such as a pull request that already exists, and asking again will not help.
      const detail = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: string }>; message?: string };
      throw new GithubError(`GitHub refused it: ${detail.errors?.[0]?.message ?? detail.message ?? res.status}.`);
    }
    if (!res.ok) throw new GithubError(`GitHub answered ${res.status}. Try again in a few minutes.`);
    return (await res.json()) as T;
  }

  /**
   * Answers with the data and the errors GitHub sent next to it. An organization that restricts
   * OAuth Apps makes GitHub leave out its pull requests and add an error for each; the rest of the
   * answer is still good, and the errors are the only sign of what is missing (K-6).
   */
  async function graphql<T>(token: string, query: string, variables: Record<string, unknown>) {
    const res = await fetch(`${config.githubApiUrl}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'WebChat' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new GithubError('GitHub no longer accepts this connection. Connect GitHub again.', true);
    if (!res.ok) throw new GithubError(`GitHub answered ${res.status}. Trying again in a few minutes.`);
    const body = (await res.json()) as { data?: T | null; errors?: GraphqlError[] };
    if (!body.data) throw new GithubError(body.errors?.[0]?.message ?? 'GitHub sent an empty answer.');
    return { data: body.data, errors: body.errors ?? [] };
  }

  async function fetchPulls(token: string, login: string, teamRepos: string[]) {
    const scope = 'is:pr is:open archived:false sort:updated-desc';
    const repos = teamRepos.slice(0, TEAM_REPOS);
    const { data, errors } = await graphql<PullsResult>(token, PULLS_QUERY, {
      reviewQuery: `${scope} review-requested:${login}`,
      authoredQuery: `${scope} author:${login}`,
      mergedQuery: `is:pr is:merged sort:updated-desc author:${login}`,
      teamQuery: `is:pr archived:false sort:updated-desc ${repos.map((r) => `repo:${r}`).join(' ')}`,
      team: repos.length > 0,
      first: PULLS_PER_LIST,
    });
    const pulls: PullListsDTO = {
      reviewRequested: toPulls(data.reviewRequested),
      authored: toPulls(data.authored),
      merged: toPulls(data.merged),
      team: toPulls(data.team ?? null),
      hiddenOrganizations: hiddenOrganizations(errors),
    };
    return { login: data.viewer.login, pulls };
  }

  /** Merged or closed events for the user's pull requests that left the open list. */
  async function endings(token: string, left: PullRequestDTO[]): Promise<NewGithubEvent[]> {
    if (left.length === 0) return [];
    const { data } = await graphql<StatesResult>(token, STATES_QUERY, { ids: left.map((p) => p.id) });
    const byId = new Map(left.map((p) => [p.id, p]));
    return data.nodes.flatMap((node) => {
      const pull = node?.id ? byId.get(node.id) : undefined;
      if (!pull) return [];
      if (node!.state === 'MERGED') return [eventFor(pull, 'merged', node!.mergedBy?.login ?? null)];
      if (node!.state === 'CLOSED') return [eventFor(pull, 'closed')];
      return [];
    });
  }

  /**
   * Pushes new events with the same rule as chat messages: only to the browser in use while the
   * user looks at the app, to every device otherwise. A tab without push finds them on its next
   * refresh and shows them itself.
   */
  async function alert(userId: number, events: GithubEventDTO[]) {
    const user = await db.getUser(userId);
    if (!user) return;
    const looking = isAttentive(user);
    // Safari counts a push that shows nothing as silent and revokes the subscription (D-047).
    if (looking && (!user.attentive_endpoint || showsEveryPush(user.attentive_endpoint))) return;
    for (const event of events.slice(-MAX_PUSHES_PER_POLL)) {
      const { title, body } = describeGithubEvent(event);
      const payload: PushPayload = {
        kind: 'github',
        title,
        body,
        bodyPrefix: '',
        urgent: false,
        // Later news about the same pull request replaces the earlier notification.
        tag: `github-${event.repo}#${event.number}`,
        conversationId: null,
        messageId: null,
        senderId: null,
        clientId: null,
        envelope: null,
        unreadTotal: null,
        sentAt: event.createdAt,
        url: event.url,
      };
      await push.sendToUser(userId, payload, looking ? user.attentive_endpoint! : undefined);
    }
  }

  /**
   * Fetches the account's pull requests and records what changed since the last poll, unless it
   * was polled within minIntervalMs. The first poll after connecting only records them.
   */
  async function poll(userId: number, minIntervalMs = POLL_INTERVAL_MS): Promise<void> {
    if (!tokens) return;
    const account = await db.claimGithubPoll(userId, minIntervalMs);
    if (!account) return;
    const token = tokens.open(account.token, userId);
    if (!token) {
      await db.setGithubError(userId, 'The server’s GitHub settings changed. Connect GitHub again.', true);
      return;
    }
    try {
      const before = account.pulls ? (JSON.parse(account.pulls) as PullListsDTO) : null;
      // All shows the repositories of the user's projects, and those their own pull requests were in last time.
      const ownRepos = [...(before?.authored ?? []), ...(before?.reviewRequested ?? [])].map((p) => p.repo);
      const teamRepos = [...new Set([...(await db.githubTeamRepos(userId)), ...ownRepos])];
      const { login, pulls } = await fetchPulls(token, account.login, teamRepos);
      const events: NewGithubEvent[] = [];
      if (before) {
        const changes = comparePulls(before, pulls, login);
        events.push(...changes.events, ...(await endings(token, changes.left)));
      }
      await db.saveGithubPulls(userId, login, JSON.stringify(pulls));
      if (events.length === 0) return;
      events.sort((a, b) => IMPORTANCE.indexOf(a.kind) - IMPORTANCE.indexOf(b.kind));
      const added = await db.addGithubEvents(userId, events);
      if (account.notify) await alert(userId, added);
    } catch (error) {
      if (!(error instanceof GithubError)) config.logger.error(`GitHub poll for user ${userId} failed`, error);
      const message = error instanceof GithubError ? error.message : 'Could not reach GitHub. Trying again in a few minutes.';
      await db.setGithubError(userId, message, error instanceof GithubError && error.revoked);
    }
  }

  return {
    configured,

    /** Polls if the last poll is older than a minute, or 10 seconds for the refresh button. */
    refresh: (userId: number, manual: boolean) => poll(userId, manual ? MANUAL_POLL_INTERVAL_MS : POLL_INTERVAL_MS),

    /** Polls every account that is due. Runs on the server's timer or when a scheduler calls in. */
    async pollAll(): Promise<number> {
      if (!configured) return 0;
      // Before polling, so a run that times out still counts: the clock that started it works.
      await db.markGithubScheduledPoll();
      const due = await db.githubAccountsDue(SCHEDULED_POLL_INTERVAL_MS);
      const queue = [...due];
      const worker = async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) await poll(id, SCHEDULED_POLL_INTERVAL_MS);
      };
      await Promise.all(Array.from({ length: POLL_CONCURRENCY }, worker));
      return due.length;
    },

    /**
     * On Vercel nothing runs between requests, and Hobby cron jobs run once a day, so the database
     * keeps the clock: a Supabase Cron job calls GET /api/github/poll every 2 minutes. Every server
     * start checks the job, so a deleted one comes back. Without pg_cron and pg_net this logs why,
     * and the pane says alerts need an open tab.
     */
    async schedulePolls(): Promise<void> {
      if (!configured || !config.githubPollUrl) return;
      try {
        if (await db.scheduleJob(GITHUB_POLL_JOB, config.githubPollUrl)) {
          config.logger.info(`Supabase Cron now calls ${config.githubPollUrl} every 2 minutes.`);
        }
      } catch (error) {
        config.logger.warn(`Could not schedule GitHub polls in the database, so alerts need an open tab: ${String(error)}`);
      }
    },

    async view(userId: number): Promise<Omit<GithubDTO, 'appConfigured'>> {
      const account = configured ? await db.githubAccount(userId) : undefined;
      const alertsWhileClosed = configured && (await db.githubScheduledPollAt()) > Date.now() - SCHEDULED_POLL_STALE_MS;
      if (!account) {
        return {
          configured,
          account: null,
          pulls: null,
          events: [],
          fetchedAt: null,
          error: null,
          reconnect: false,
          alertsWhileClosed,
        };
      }
      return {
        configured,
        account: { login: account.login, name: account.name, notify: account.notify },
        pulls: account.pulls ? (JSON.parse(account.pulls) as PullListsDTO) : null,
        events: await db.githubEvents(userId),
        fetchedAt: account.fetched_at,
        error: account.error,
        reconnect: account.revoked,
        alertsWhileClosed,
      };
    },

    /**
     * Starts linking: returns GitHub's sign-in URL, and the value to keep in a short-lived cookie
     * until GitHub sends the user back. The state stops another site from linking its own account
     * to this user; PKCE makes a stolen code useless.
     */
    beginConnect(userId: number, redirectUri: string): { url: string; cookie: string } {
      const state = crypto.randomBytes(24).toString('base64url');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const url = new URL('/login/oauth/authorize', config.githubOauthUrl);
      url.search = new URLSearchParams({
        client_id: clientId!,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
        allow_signup: 'false',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.toString(), cookie: [userId, state, verifier].join('.') };
    },

    /** Finishes linking once GitHub sends the user back with a code. */
    async completeConnect(userId: number, cookie: string | undefined, state: string, code: string, redirectUri: string) {
      const [cookieUser, cookieState, verifier] = (cookie ?? '').split('.');
      if (Number(cookieUser) !== userId || !cookieState || !verifier || !state || !safeEqual(cookieState, state)) {
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
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // GitHub reports a bad code in the body, not always with an error status.
      const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!res.ok || !data.access_token) throw new GithubError(`GitHub refused the sign-in (${data.error ?? res.status}).`);
      const user = await rest<{ id: number; login: string; name: string | null }>(data.access_token, '/user');
      await db.saveGithubAccount(userId, {
        githubId: user.id,
        login: user.login,
        name: user.name,
        token: tokens!.seal(data.access_token, userId),
      });
    },

    setNotify: (userId: number, notify: boolean) => db.setGithubNotify(userId, notify),

    /**
     * The branches the user could open a pull request from: the newest ones without any pull
     * request, other than the default branch, in the repositories of their pull requests and projects.
     */
    async branches(userId: number): Promise<BranchChoiceDTO[]> {
      const [{ account, token }, teamRepos] = await Promise.all([tokenOf(userId), db.githubTeamRepos(userId)]);
      const lists = account.pulls ? (JSON.parse(account.pulls) as PullListsDTO) : null;
      const repos = [...new Set([...teamRepos, ...(lists?.authored ?? []).map((p) => p.repo)])].slice(0, BRANCH_REPOS);
      if (repos.length === 0) return [];
      const variables = Object.fromEntries(
        repos.flatMap((repo, i) => {
          const [owner, name] = repo.split('/');
          return [
            [`o${i}`, owner],
            [`n${i}`, name],
          ];
        }),
      );
      const { data } = await graphql<Record<string, BranchesRepo | null>>(token, branchesQuery(repos.length), variables);
      return Object.values(data)
        .flatMap((repo) =>
          (repo?.refs?.nodes ?? []).flatMap((ref) =>
            ref && repo!.defaultBranchRef && ref.name !== repo!.defaultBranchRef.name && ref.associatedPullRequests.totalCount === 0
              ? [
                  {
                    repo: repo!.nameWithOwner,
                    base: repo!.defaultBranchRef!.name,
                    branch: ref.name,
                    title: ref.target?.messageHeadline || ref.name,
                    updatedAt: Date.parse(ref.target?.committedDate ?? '') || 0,
                  },
                ]
              : [],
          ),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },

    /** Opens a draft pull request, then polls so the pane shows it. */
    async openPull(userId: number, input: OpenPullInput): Promise<{ url: string }> {
      const { token } = await tokenOf(userId);
      const pull = await rest<{ html_url: string }>(token, `/repos/${input.repo}/pulls`, {
        title: input.title,
        head: input.branch,
        base: input.base,
        draft: true,
      });
      await poll(userId, MANUAL_POLL_INTERVAL_MS);
      return { url: pull.html_url };
    },

    /** Unlinks the account here, and deletes the app's grant on GitHub so the token stops working. */
    async disconnect(userId: number) {
      const account = await db.githubAccount(userId);
      if (!account) return;
      await db.deleteGithubAccount(userId);
      const token = tokens?.open(account.token, userId);
      if (!token) return;
      const res = await fetch(`${config.githubApiUrl}/applications/${encodeURIComponent(clientId!)}/grant`, {
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
        config.logger.warn(`Could not revoke the GitHub grant of user ${userId}: ${String(error)}`);
        return null;
      });
      // 404 or 422: the user already revoked it on GitHub.
      if (res && !res.ok && res.status !== 404 && res.status !== 422) {
        config.logger.warn(`Could not revoke the GitHub grant of user ${userId} (${res.status}).`);
      }
    },
  };
}
