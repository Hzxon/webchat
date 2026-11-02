import { useState } from 'react';
import { describeGithubEvent } from '../../../shared/github';
import type { GithubAccountDTO, GithubDTO, GithubEventDTO, GithubEventKind, PullRequestDTO } from '../../../shared/types';
import { connectGithub, disconnectGithub, refreshGithub, setGithubNotify } from '../github';
import { actions, useAppState } from '../store';
import { formatAgo } from './format';
import { AlertIcon, BackIcon, BellIcon, CommentIcon, GithubIcon, PullRequestIcon, RefreshIcon, ShareIcon } from './icons';
import { PullTags, type Tone } from './PullTags';
import { SharePullDialog } from './SharePullDialog';

/** The pull requests pane: takes the place of a chat, with a back button on phones. */
export function GithubView() {
  const github = useAppState((s) => s.github);
  const [refreshing, setRefreshing] = useState(false);
  const account = github?.account ?? null;

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshGithub(true);
    } finally {
      setRefreshing(false);
    }
  }

  let subtitle = 'GitHub';
  if (account) subtitle = `@${account.login}${github?.fetchedAt ? ` · updated ${formatAgo(github.fetchedAt)}` : ''}`;

  return (
    <section className="chat github-pane">
      <header className="chat-header">
        <button className="icon-button back-button" onClick={() => actions.setGithubOpen(false)} aria-label="Back to chats">
          <BackIcon />
        </button>
        <span className="github-mark">
          <PullRequestIcon />
        </span>
        <div className="chat-header-text">
          <strong>Pull requests</strong>
          <span>{subtitle}</span>
        </div>
        {account && !github?.reconnect && (
          <button
            className="icon-button header-end"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Check GitHub now"
            aria-label="Check GitHub now"
          >
            <RefreshIcon className={refreshing ? 'spin' : undefined} />
          </button>
        )}
      </header>
      {account && github?.error && (
        <div className="banner banner-warn" role="status">
          <AlertIcon width={18} height={18} />
          <span>{github.error}</span>
          {github.reconnect && (
            <button className="button-secondary banner-action" onClick={connectGithub}>
              Connect again
            </button>
          )}
        </div>
      )}
      {account?.notify && !github?.reconnect && !github?.alertsWhileClosed && (
        <div className="banner" role="status">
          <BellIcon width={18} height={18} />
          <span>
            Pull request alerts arrive only while a WebChat tab is open. The person who runs this WebChat can turn on
            alerts with every tab closed: the README explains how.
          </span>
        </div>
      )}
      <div className="github-body">
        {!github ? (
          <p className="github-empty">Loading…</p>
        ) : !github.configured ? (
          <NotConfigured />
        ) : !account ? (
          <ConnectCard alertsWhileClosed={github.alertsWhileClosed} />
        ) : (
          <Connected github={github} account={account} />
        )}
      </div>
    </section>
  );
}

function NotConfigured() {
  return (
    <div className="github-card">
      <span className="github-card-icon">
        <GithubIcon width={30} height={30} />
      </span>
      <h2>GitHub is not set up here</h2>
      <p>
        The person who runs this WebChat needs to create a GitHub OAuth App and set GITHUB_CLIENT_ID and
        GITHUB_CLIENT_SECRET. The README explains how.
      </p>
    </div>
  );
}

/** Promises alerts with every tab closed only while a timer or a scheduler is polling (K-5). */
function ConnectCard({ alertsWhileClosed }: { alertsWhileClosed: boolean }) {
  return (
    <div className="github-card">
      <span className="github-card-icon">
        <GithubIcon width={30} height={30} />
      </span>
      <h2>Follow your pull requests</h2>
      <p>
        Connect your GitHub account to see the pull requests waiting for your review, and how your own are doing: checks,
        reviews, comments, and conflicts.{' '}
        {alertsWhileClosed
          ? 'WebChat alerts you when they change, even with this tab closed.'
          : 'WebChat alerts you when they change while any of its tabs is open.'}
      </p>
      <button className="button-primary github-connect" onClick={connectGithub}>
        <GithubIcon width={18} height={18} />
        Connect GitHub
      </button>
      <p className="github-fineprint">
        GitHub will ask for access to your repositories, private ones included: it has no read-only access for them.
        WebChat only reads pull requests. The access token stays on the server, encrypted, and never reaches this
        browser. Disconnecting deletes it and revokes the access on GitHub.
      </p>
    </div>
  );
}

function Connected({ github, account }: { github: GithubDTO; account: GithubAccountDTO }) {
  return (
    <>
      {github.pulls ? (
        <>
          <PullSection
            title="Waiting for your review"
            pulls={github.pulls.reviewRequested}
            empty="Nobody is waiting for your review."
            showAuthor
          />
          <PullSection title="Your pull requests" pulls={github.pulls.authored} empty="You have no open pull requests." />
        </>
      ) : (
        !github.error && <p className="github-empty">Loading your pull requests from GitHub…</p>
      )}
      <Activity events={github.events} />
      <Settings account={account} />
    </>
  );
}

function PullSection({
  title,
  pulls,
  empty,
  showAuthor = false,
}: {
  title: string;
  pulls: PullRequestDTO[];
  empty: string;
  showAuthor?: boolean;
}) {
  return (
    <section className="github-section">
      <h3>
        {title} <span className="github-count">{pulls.length}</span>
      </h3>
      {pulls.length === 0 ? (
        <p className="github-empty">{empty}</p>
      ) : (
        <ul className="pull-list">
          {pulls.map((pull) => (
            <PullItem key={pull.id} pull={pull} showAuthor={showAuthor} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PullItem({ pull, showAuthor }: { pull: PullRequestDTO; showAuthor: boolean }) {
  const [sharing, setSharing] = useState(false);
  return (
    <li className="pull-row">
      <a className="pull" href={pull.url} target="_blank" rel="noopener noreferrer">
        <span className={`pull-icon ${pull.draft ? 'is-draft' : ''}`}>
          <PullRequestIcon width={18} height={18} />
        </span>
        <span className="pull-main">
          <span className="pull-title">{pull.title}</span>
          <span className="pull-meta">
            {pull.repo}#{pull.number}
            {showAuthor && pull.author ? ` · ${pull.author}` : ''} · {formatAgo(pull.updatedAt)}
          </span>
          <span className="pull-tags">
            <PullTags pull={pull} />
            <span className="pull-size" aria-label={`${pull.additions} lines added, ${pull.deletions} removed`}>
              <span className="pull-add">+{pull.additions}</span> <span className="pull-del">−{pull.deletions}</span>
            </span>
            {pull.comments > 0 && (
              <span className="pull-comments" aria-label={`${pull.comments} comments`}>
                <CommentIcon width={13} height={13} />
                {pull.comments}
              </span>
            )}
          </span>
        </span>
      </a>
      <button className="icon-button pull-share" onClick={() => setSharing(true)} title="Share to a chat" aria-label="Share to a chat">
        <ShareIcon width={18} height={18} />
      </button>
      {sharing && <SharePullDialog pull={pull} onClose={() => setSharing(false)} />}
    </li>
  );
}

const EVENT_TONES: Record<GithubEventKind, Tone> = {
  review_requested: 'info',
  approved: 'ok',
  changes_requested: 'danger',
  commented: 'info',
  checks_failed: 'danger',
  checks_passed: 'ok',
  conflicts: 'warn',
  merged: 'ok',
  closed: 'muted',
};

function Activity({ events }: { events: GithubEventDTO[] }) {
  return (
    <section className="github-section">
      <h3>Recent activity</h3>
      {events.length === 0 ? (
        <p className="github-empty">Reviews, checks, comments, and merges on these pull requests will show up here.</p>
      ) : (
        <ul className="activity-list">
          {events.slice(0, 20).map((event) => {
            const { title, body } = describeGithubEvent(event);
            return (
              <li key={event.id}>
                <a className="activity" href={event.url} target="_blank" rel="noopener noreferrer">
                  <span className={`activity-dot tone-${EVENT_TONES[event.kind]}`} />
                  <span className="activity-main">
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </span>
                  <time>{formatAgo(event.createdAt)}</time>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Settings({ account }: { account: GithubAccountDTO }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setNote('');
    try {
      await work();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="github-section github-settings">
      <label className="toggle-row">
        <BellIcon />
        <span>
          <strong>Alerts for pull request changes</strong>
          <small>Review requests, reviews, checks, comments, conflicts, and merges. They arrive like messages.</small>
        </span>
        <input
          type="checkbox"
          checked={account.notify}
          disabled={busy}
          onChange={(e) => void act(() => setGithubNotify(e.target.checked))}
        />
      </label>
      <div className="github-account">
        <GithubIcon width={18} height={18} />
        <span>
          Connected as <strong>@{account.login}</strong>
          {account.name ? ` (${account.name})` : ''}
        </span>
        <button
          className="button-secondary"
          disabled={busy}
          onClick={() => {
            if (confirm('Disconnect GitHub? WebChat deletes its access token and stops watching your pull requests.')) {
              void act(disconnectGithub);
            }
          }}
        >
          Disconnect
        </button>
      </div>
      {note && <p className="dialog-note">{note}</p>}
    </section>
  );
}
