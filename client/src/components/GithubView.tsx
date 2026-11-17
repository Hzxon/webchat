import { useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { describeGithubEvent } from '../../../shared/github';
import type {
  GithubAccountDTO,
  GithubDTO,
  GithubEventDTO,
  GithubEventKind,
  PullRequestDTO,
} from '../../../shared/types';
import { connectGithub, disconnectGithub, refreshGithub, setGithubNotify } from '../github';
import { actions, useAppState } from '../store';
import { formatAgo } from './format';
import {
  BackIcon,
  BellIcon,
  CommentIcon,
  GithubIcon,
  LockIcon,
  PullRequestIcon,
  RefreshIcon,
  ShareIcon,
} from './icons';
import { PullTags, type Tone } from './PullTags';
import { SharePullDialog } from './SharePullDialog';
import { confirmAction } from './ConfirmHost';

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
        <IconButton
          className="back-button"
          variant="ghost"
          label="Back to chats"
          tooltip="Back to chats"
          icon={<BackIcon />}
          onClick={() => actions.setGithubOpen(false)}
        />
        <span className="github-mark">
          <PullRequestIcon />
        </span>
        <div className="chat-header-text">
          <strong>Pull requests</strong>
          <span>{subtitle}</span>
        </div>
        {account && !github?.reconnect && (
          <IconButton
            className="header-end"
            variant="ghost"
            label="Check GitHub now"
            tooltip="Check GitHub now"
            icon={<RefreshIcon className={refreshing ? 'spin' : undefined} />}
            isDisabled={refreshing}
            onClick={() => void refresh()}
          />
        )}
      </header>
      {account && github?.error && (
        <Banner
          status="warning"
          title={github.error}
          endContent={github.reconnect && <Button size="sm" label="Connect again" onClick={connectGithub} />}
        />
      )}
      {account && !github?.reconnect && github?.pulls?.hiddenOrganizations?.length ? (
        <HiddenOrganizations names={github.pulls.hiddenOrganizations} />
      ) : null}
      {account?.notify && !github?.reconnect && !github?.alertsWhileClosed && (
        <Banner
          status="info"
          icon={<BellIcon width={18} height={18} />}
          title="Pull request alerts arrive only while a WebChat tab is open. The person who runs this WebChat can turn on alerts with every tab closed: the README explains how."
        />
      )}
      <div className="github-body">
        {!github ? (
          <Text as="p" color="secondary">
            Loading…
          </Text>
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

/** A member can ask the owners of an organization to approve the app from their own GitHub settings. */
const REQUEST_APPROVAL_URL =
  'https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-your-membership-in-organizations/requesting-organization-approval-for-oauth-apps';

/**
 * Names the organizations whose pull requests GitHub leaves out because they restrict OAuth Apps
 * (K-6). Without this the lists look complete, and a student cannot tell that an owner has to act.
 */
function HiddenOrganizations({ names }: { names: string[] }) {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const phrase =
    names.length === 1
      ? `The ${list} organization hides its pull requests until one of its owners approves WebChat.`
      : `The organizations ${list} hide their pull requests until their owners approve WebChat.`;
  return (
    <Banner
      status="info"
      icon={<LockIcon width={18} height={18} />}
      title={
        <>
          {phrase}{' '}
          <Link href={REQUEST_APPROVAL_URL} target="_blank" rel="noopener noreferrer">
            You can ask for that approval on GitHub.
          </Link>
        </>
      }
    />
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
        Connect your GitHub account to see the pull requests waiting for your review, and how your own are doing:
        checks, reviews, comments, and conflicts.{' '}
        {alertsWhileClosed
          ? 'WebChat alerts you when they change, even with this tab closed.'
          : 'WebChat alerts you when they change while any of its tabs is open.'}
      </p>
      <Button
        variant="primary"
        label="Connect GitHub"
        icon={<GithubIcon width={18} height={18} />}
        onClick={connectGithub}
      />
      <p className="github-fineprint">
        GitHub will ask for access to your repositories, private ones included: it has no read-only access for them.
        WebChat only reads pull requests. The access token stays on the server, encrypted, and never reaches this
        browser. Disconnecting deletes it and revokes the access on GitHub. An organization that restricts OAuth Apps,
        as a course organization often does, hides its pull requests until one of its owners approves WebChat; the pane
        names it when that happens.
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
          <PullSection
            title="Your pull requests"
            pulls={github.pulls.authored}
            empty="You have no open pull requests."
          />
        </>
      ) : (
        !github.error && (
          <Text as="p" color="secondary">
            Loading your pull requests from GitHub…
          </Text>
        )
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
        {title} <Badge variant="info" label={pulls.length} />
      </h3>
      {pulls.length === 0 ? (
        <Text as="p" color="secondary">
          {empty}
        </Text>
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
      <IconButton
        className="pull-share"
        variant="ghost"
        label="Share to a chat"
        tooltip="Share to a chat"
        icon={<ShareIcon width={18} height={18} />}
        onClick={() => setSharing(true)}
      />
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
        <Text as="p" color="secondary">
          Reviews, checks, comments, and merges on these pull requests will show up here.
        </Text>
      ) : (
        <List hasDividers edge="flush">
          {events.slice(0, 20).map((event) => {
            const { title, body } = describeGithubEvent(event);
            return (
              <ListItem
                key={event.id}
                href={event.url}
                target="_blank"
                rel="noopener noreferrer"
                startContent={<span className={`activity-dot tone-${EVENT_TONES[event.kind]}`} />}
                label={title}
                description={body}
                endContent={<Text color="secondary">{formatAgo(event.createdAt)}</Text>}
              />
            );
          })}
        </List>
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
      <Switch
        labelIcon="bell"
        label="Alerts for pull request changes"
        description="Review requests, reviews, checks, comments, conflicts, and merges. They arrive like messages."
        labelSpacing="spread"
        value={account.notify}
        isDisabled={busy}
        onChange={(checked) => void act(() => setGithubNotify(checked))}
      />
      <div className="github-account">
        <GithubIcon width={18} height={18} />
        <span>
          Connected as <strong>@{account.login}</strong>
          {account.name ? ` (${account.name})` : ''}
        </span>
        <Button
          label="Disconnect"
          isDisabled={busy}
          onClick={async () => {
            const yes = await confirmAction({
              title: 'Disconnect GitHub?',
              body: 'WebChat deletes its access token and stops watching your pull requests.',
              confirmLabel: 'Disconnect',
            });
            if (yes) void act(disconnectGithub);
          }}
        />
      </div>
      {note && (
        <Text as="p" weight="semibold">
          {note}
        </Text>
      )}
    </section>
  );
}
