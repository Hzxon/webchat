// Keeps the pull requests pane fresh, alerts about pull request changes the server found, and
// shares the user's new pull requests into the projects that link their repository.
//
// The server polls GitHub at most once a minute per account, however many tabs ask, and records
// each change as an event. Open tabs ask every minute while visible and every few minutes in the
// background. A GitHub push makes them ask at once.
import { describeGithubEvent } from '../../shared/github';
import type { GithubDTO, GithubEventDTO, PullRequestDTO } from '../../shared/types';
import { sound } from './alerts';
import { api, ApiError } from './api';
import { attention } from './attention';
import { showLocalNotification } from './push';
import { actions, store } from './store';

type SharePull = (conversationId: number, pull: PullRequestDTO) => Promise<void>;

let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;
let loadedAt = 0;
/** Newest event already handled. Null until the first load, so events from before never alert. */
let lastEventId: number | null = null;
let pushActiveHere: () => boolean = () => false;
let sharePull: SharePull = () => Promise.resolve();
/** Shares this tab is posting now, so a refresh that lands meanwhile leaves them alone. */
const posting = new Set<number>();

const interval = () => (document.visibilityState === 'visible' ? 60_000 : 180_000);

function schedule(delay: number) {
  clearTimeout(timer);
  if (running) timer = setTimeout(() => void refreshGithub(), delay);
}

/** Loads the pull requests. With manual set, the server checks GitHub again even if it did a moment ago. */
export function refreshGithub(manual = false): Promise<void> {
  if (!running) return Promise.resolve();
  inFlight ??= (async () => {
    let next = interval();
    try {
      const github = await api.github(manual);
      if (!running) return;
      loadedAt = Date.now();
      actions.setGithub(github);
      announce(github);
      void shareWaiting(github);
      // Nothing to watch without a connected account; connecting reloads the page anyway.
      if (!github.account || github.reconnect) next = 0;
      // Just connected: the first poll is still running on another request.
      else if (!github.pulls && !github.error) next = 3000;
    } catch (error) {
      // A signed-out session is handled by the chat's own check-in.
      if (!(error instanceof ApiError && error.status === 401)) console.warn('Could not load pull requests', error);
    } finally {
      inFlight = null;
      if (next > 0) schedule(next);
    }
  })();
  return inFlight;
}

/** Shows events that arrived since the last load, unless alerts are off. */
function announce(github: GithubDTO) {
  const newest = github.events[0]?.id ?? 0;
  const previous = lastEventId;
  lastEventId = Math.max(previous ?? 0, newest);
  if (previous === null || !github.account?.notify) return;
  for (const event of github.events.filter((e) => e.id > previous).reverse()) alertAbout(event);
}

/** Same rule as chat messages: a toast while looking, otherwise a notification unless push already sent one. */
function alertAbout(event: GithubEventDTO) {
  const { title, body } = describeGithubEvent(event);
  if (attention.isAttentive()) {
    sound.message();
    actions.addToast({ conversationId: null, url: event.url, title, body });
  } else if (!pushActiveHere()) {
    void showLocalNotification(title, body, `github-${event.repo}#${event.number}`, false, { url: event.url });
  }
}

/**
 * Posts the user's new pull requests into the channels of the projects that link their repository
 * (D-046). The server only says which ones wait: this browser encrypts and signs each card, like a
 * card shared by hand. The claim comes first, so only one of the user's tabs posts it.
 */
async function shareWaiting(github: GithubDTO) {
  for (const share of github.shares) {
    const chat = store.get().conversations[share.conversationId];
    // A channel this tab has not loaded yet is offered again on the next refresh.
    if (!chat || posting.has(share.id)) continue;
    posting.add(share.id);
    try {
      await api.claimPullShare(share.id);
      await sharePull(share.conversationId, share.pull);
      actions.addToast({ conversationId: chat.id, title: `Shared to #${chat.title ?? 'channel'}`, body: share.pull.title });
    } catch (error) {
      // 409: another tab claimed it first, or the user left the channel.
      if (!(error instanceof ApiError && error.status === 409)) console.warn('Could not share a pull request', error);
    } finally {
      posting.delete(share.id);
    }
  }
}

const RETURN_TOASTS: Record<string, { title: string; body: string }> = {
  connected: { title: 'GitHub connected', body: 'Your pull requests are loading.' },
  denied: { title: 'GitHub not connected', body: 'The sign-in on GitHub was cancelled.' },
  error: { title: 'GitHub not connected', body: 'Something went wrong. Try again in a moment.' },
};

/** GitHub sends the browser back to /?github=<result> after linking. Opens the pane and says how it went. */
function handleReturn() {
  const result = new URLSearchParams(location.search).get('github');
  if (result === null) return;
  history.replaceState(null, '', '/');
  actions.setGithubOpen(true);
  const toast = RETURN_TOASTS[result];
  if (toast) actions.addToast({ conversationId: null, ...toast });
}

/**
 * Starts loading pull requests for the signed-in account. share posts a card into a chat; it comes
 * from the chat module, which imports this one. Returns the function that stops it.
 */
export function startGithub(isPushActiveHere: () => boolean, share: SharePull): () => void {
  running = true;
  lastEventId = null;
  loadedAt = 0;
  pushActiveHere = isPushActiveHere;
  sharePull = share;
  handleReturn();
  void refreshGithub();

  // A background tab asks less often; catch up as soon as it is looked at again.
  const onVisible = () => {
    const github = store.get().github;
    if (document.visibilityState === 'visible' && github?.account && Date.now() - loadedAt > 60_000) void refreshGithub();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    running = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** Leaves the app for GitHub's sign-in page. The server sends the browser back when it is done. */
export function connectGithub() {
  location.assign('/api/github/connect');
}

export async function disconnectGithub() {
  actions.setGithub(await api.disconnectGithub());
}

export async function setGithubNotify(notify: boolean) {
  actions.setGithub(await api.setGithubNotify(notify));
}

export async function setGithubAutoShare(autoShare: boolean) {
  actions.setGithub(await api.setGithubAutoShare(autoShare));
}
