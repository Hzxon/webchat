import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { describeGithubEvent } from '../../../shared/github';
import type { Card } from '../../../shared/board';
import type {
  BranchChoiceDTO,
  GithubAccountDTO,
  GithubDTO,
  GithubEventDTO,
  GithubEventKind,
  PullRequestDTO,
} from '../../../shared/types';
import { api } from '../api';
import { runnerOf } from '../board';
import { boardCards } from '../docs';
import { connectGithub, disconnectGithub, refreshGithub, setGithubNotify } from '../github';
import { actions, useAppState } from '../store';
import { Dialog } from './Dialog';
import { formatAgo } from './format';
import {
  BackIcon,
  BellIcon,
  CloseIcon,
  CommentIcon,
  GithubIcon,
  LockIcon,
  PlusIcon,
  PullRequestIcon,
  RefreshIcon,
  ShareIcon,
} from './icons';
import { PullChips, PullMark, svg, type Tone } from './PullTags';
import { SharePullDialog } from './SharePullDialog';
import { confirmAction } from './ConfirmHost';

/** The pull requests pane: takes the place of a chat, with a back button on phones. */
export function GithubView() {
  const github = useAppState((s) => s.github);
  const account = github?.account ?? null;
  const connected = !!(github?.configured && account);

  return (
    <section className="chat github-pane">
      {!connected && (
        <header className="chat-header">
          <BackButton />
          <span className="github-mark">
            <PullRequestIcon />
          </span>
          <div className="chat-header-text">
            <strong>Pull requests</strong>
            <span>GitHub</span>
          </div>
        </header>
      )}
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
      {connected ? (
        <Pulls github={github!} account={account!} />
      ) : (
        <div className="github-body">
          {!github ? (
            <Text as="p" color="secondary">
              Loading…
            </Text>
          ) : !github.configured ? (
            <NotConfigured />
          ) : (
            <ConnectCard alertsWhileClosed={github.alertsWhileClosed} />
          )}
        </div>
      )}
    </section>
  );
}

const BackButton = () => (
  <IconButton
    className="back-button"
    variant="ghost"
    label="Back to chats"
    tooltip="Back to chats"
    icon={<BackIcon />}
    onClick={() => actions.setGithubOpen(false)}
  />
);

type LaneKey = 'draft' | 'review' | 'approved' | 'merged';
type Lane = (typeof LANES)[number];
/** The Merged lane shows the newest few; Show all opens them in the List view. */
const MERGED_CARDS = 3;
type Sort = 'newest' | 'oldest' | 'owner' | 'id';
type Show = 'all' | 'mine' | 'waiting';

const LANES: Array<{ key: LaneKey; title: string; tab: string; mark: 'draft' | 'ready' | 'approved' | 'merged' }> = [
  { key: 'draft', title: 'Draft', tab: 'Draft', mark: 'draft' },
  { key: 'review', title: 'In review', tab: 'Review', mark: 'ready' },
  { key: 'approved', title: 'Approved', tab: 'Approved', mark: 'approved' },
  { key: 'merged', title: 'Merged', tab: 'Merged', mark: 'merged' },
];
const SORTS: Array<[Sort, string]> = [
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['owner', 'Owner'],
  ['id', 'Id'],
];
const SHOWS: Array<[Show, string]> = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['waiting', 'Waiting for my review'],
];
const ORDER: Record<Sort, (a: PullRequestDTO, b: PullRequestDTO) => number> = {
  newest: (a, b) => b.updatedAt - a.updatedAt,
  oldest: (a, b) => a.updatedAt - b.updatedAt,
  owner: (a, b) => (a.author ?? '').localeCompare(b.author ?? '') || b.updatedAt - a.updatedAt,
  id: (a, b) => b.number - a.number,
};

const laneOf = (pull: PullRequestDTO): LaneKey =>
  pull.mergedAt ? 'merged' : pull.draft ? 'draft' : pull.review === 'approved' ? 'approved' : 'review';

/** The same pull request can come in several lists; the first copy wins. */
const unique = (pulls: PullRequestDTO[]) => [...new Map(pulls.map((p) => [p.id, p] as const)).values()];

/** "2 min", "1 h", "3 d", "2 w": short enough for a card's corner. */
function shortAgo(ts: number) {
  const minutes = Math.floor((Date.now() - ts) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} d` : `${Math.floor(days / 7)} w`;
}

/**
 * A GitHub login has no WebChat account behind it. The user's own face takes the accent tint, as
 * in the design; anyone else's takes one of the other three, from its letters.
 */
function Face({ login, label = login ?? 'Unknown' }: { login: string | null; label?: string }) {
  const me = useAppState((s) => s.github?.account?.login.toLowerCase());
  const tint = login?.toLowerCase() === me ? 0 : 1 + ([...(login ?? '')].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3);
  return (
    <span className={`pulls-face tint-${tint}`} role="img" aria-label={label} title={label}>
      {(login ?? '?').slice(0, 2).toUpperCase()}
    </span>
  );
}

/**
 * The board cards the pull requests belong to, found once each time the boards change: a card whose
 * status names the pull request, or whose id the title starts with, on a board that copies to its
 * repository (R-040). Each maps to a function that opens the card's peek.
 */
function usePeeks(pulls: PullRequestDTO[]) {
  const docs = useAppState((s) => s.docs);
  const conversations = useAppState((s) => s.conversations);
  const [cards, setCards] = useState<Array<{ projectId: number; repo: string; card: Card }>>([]);
  const repos = [...new Set(pulls.map((p) => p.repo.toLowerCase()))].sort().join();
  useEffect(() => {
    let live = true;
    const wanted = repos.split(',');
    const boards = Object.values(docs).filter((d) => d.board === 'roadmap' && d.repo && wanted.includes(d.repo.toLowerCase()));
    void Promise.all(
      boards.map(async (doc) => {
        const projectId = conversations[doc.conversationId]?.projectId;
        if (projectId == null) return [];
        // A board that does not load leaves its pull requests as links to GitHub.
        const found = await boardCards(doc).catch(() => []);
        return found.map((card) => ({ projectId, repo: doc.repo!.toLowerCase(), card }));
      }),
    ).then((all) => live && setCards(all.flat()));
    return () => {
      live = false;
    };
  }, [docs, conversations, repos]);
  return useMemo(() => {
    const peeks = new Map<string, () => void>();
    for (const pull of pulls) {
      const [, kind, number] = /^([KRQD])-(\d+)\b/.exec(pull.title) ?? [];
      const at = cards.find(
        ({ repo, card }) =>
          repo === pull.repo.toLowerCase() &&
          (runnerOf(card.status) === `${pull.repo}#${pull.number}` || (card.kind === kind && card.number === Number(number))),
      );
      if (at) peeks.set(pull.id, () => actions.setBoardOpen(at.projectId, at.card.id));
    }
    return peeks;
  }, [pulls, cards]);
}

function Pulls({ github, account }: { github: GithubDTO; account: GithubAccountDTO }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [layout, setLayout] = useState<'board' | 'list'>('board');
  const [showMerged, setShowMerged] = useState(false);
  const [folded, setFolded] = useState<LaneKey[]>([]);
  const [menu, setMenu] = useState<LaneKey | null>(null);
  const [prefs, setPrefs] = useState<Partial<Record<LaneKey, { sort: Sort; show: Show }>>>({});
  const [phoneLane, setPhoneLane] = useState<LaneKey>('draft');
  const [opening, setOpening] = useState(false);
  const [settings, setSettings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState('');

  const lists = github.pulls;
  const waiting = useMemo(() => new Set(lists?.reviewRequested.map((p) => p.id)), [lists]);
  const me = account.login.toLowerCase();
  const pulls = useMemo(() => {
    if (!lists) return [];
    // For you also holds the teammates' pull requests the user approved, as the design's Approved lane does.
    const approved = (p: PullRequestDTO) => p.approvedBy?.some((login) => login.toLowerCase() === me);
    const team = scope === 'all' ? (lists.team ?? []) : (lists.team ?? []).filter(approved);
    return unique([...lists.authored, ...lists.reviewRequested, ...(lists.merged ?? []), ...team]).filter(
      (p) => p.mergedAt || !p.closed,
    );
  }, [lists, scope, me]);
  const lanes = useMemo(
    () =>
      LANES.filter((l) => l.key !== 'merged' || showMerged).map((lane) => {
        const { sort = 'newest', show = 'all' } = prefs[lane.key] ?? {};
        const shown = pulls
          .filter((p) => laneOf(p) === lane.key)
          .filter((p) => show === 'all' || (show === 'mine' ? p.author?.toLowerCase() === me : waiting.has(p.id)))
          .sort(ORDER[sort]);
        return { ...lane, pulls: shown };
      }),
    [pulls, prefs, waiting, showMerged, me],
  );
  const mergedCount = pulls.filter((p) => p.mergedAt).length;
  const authors = [...new Set(pulls.filter((p) => !p.mergedAt).flatMap((p) => (p.author ? [p.author] : [])))];
  const current = lanes.some((l) => l.key === phoneLane) ? phoneLane : 'draft';
  const peeks = usePeeks(pulls);

  const setPref = (key: LaneKey, change: Partial<{ sort: Sort; show: Show }>) => {
    setPrefs((was) => ({ ...was, [key]: { sort: 'newest', show: 'all', ...was[key], ...change } }));
    setMenu(null);
  };
  const fold = (key: LaneKey) => {
    setFolded((was) => [...was, key]);
    setMenu(null);
  };

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshGithub(true);
    } finally {
      setRefreshing(false);
    }
  }

  const laneMenu = ({ key, title }: Lane) => {
    const { sort = 'newest', show = 'all' } = prefs[key] ?? {};
    return (
      <>
        <button type="button" className="pulls-menu-back" aria-label="Close" onClick={() => setMenu(null)} />
        <div
          className="pulls-menu"
          role="menu"
          aria-label={`${title} lane`}
          onKeyDown={(e) => e.key === 'Escape' && setMenu(null)}
        >
          <span className="pulls-grab" aria-hidden="true" />
          <span className="pulls-menu-label">Sort by</span>
          {SORTS.map(([value, label]) => (
            <MenuChoice key={value} label={label} checked={sort === value} onClick={() => setPref(key, { sort: value })} />
          ))}
          <hr />
          <span className="pulls-menu-label">Show</span>
          {SHOWS.map(([value, label]) => (
            <MenuChoice key={value} label={label} checked={show === value} onClick={() => setPref(key, { show: value })} />
          ))}
          {key !== 'merged' && (
            <span className="pulls-fold">
              <hr />
              <button type="button" role="menuitem" onClick={() => fold(key)}>
                <FoldIcon />
                Fold lane
              </button>
            </span>
          )}
        </div>
      </>
    );
  };

  /** The List view's group heads carry only +, as the design's do. */
  const laneButtons = ({ key, title }: Lane, list = false) =>
    key === 'merged' ? (
      !list && (
        <button type="button" className="pulls-icon" aria-label="Hide merged" title="Hide merged" onClick={() => setShowMerged(false)}>
          <CloseIcon width={16} height={16} />
        </button>
      )
    ) : (
      <>
        <button
          type="button"
          className="pulls-icon"
          aria-label={`New pull request in ${title}`}
          title="Open a pull request"
          onClick={() => setOpening(true)}
        >
          <PlusIcon width={16} height={16} />
        </button>
        {!list && (
          <button
            type="button"
            className="pulls-icon"
            aria-label={`More for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu === key}
            onClick={() => setMenu(menu === key ? null : key)}
          >
            <DotsIcon />
          </button>
        )}
      </>
    );

  return (
    <>
      <header className="pulls-header">
        <BackButton />
        <h1>Pull requests</h1>
        <span className="pulls-seg" role="group" aria-label="Show">
          <SegButton pressed={scope === 'mine'} onClick={() => setScope('mine')}>
            For you
          </SegButton>
          <SegButton pressed={scope === 'all'} onClick={() => setScope('all')}>
            All
          </SegButton>
        </span>
        <span className="pulls-gap" />
        {folded.map((key) => {
          const lane = lanes.find((l) => l.key === key)!;
          return (
            <button
              key={key}
              type="button"
              className="pulls-fold-chip"
              aria-label={`Unfold ${lane.title}`}
              title={`Unfold ${lane.title}`}
              onClick={() => setFolded((was) => was.filter((k) => k !== key))}
            >
              <PullMark state={lane.mark} />
              {lane.title}
              <span className="pulls-n">{lane.pulls.length}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="pulls-quiet"
          aria-label={`Show ${mergedCount} merged`}
          aria-pressed={showMerged}
          onClick={() => {
            setShowMerged(!showMerged);
            if (!showMerged) setPhoneLane('merged');
          }}
        >
          <PullMark state="merged" />
          Merged<span className="pulls-n">{mergedCount}</span>
        </button>
        {authors.length > 0 && (
          <span className="pulls-stack" aria-label="People with open pull requests">
            {authors.slice(0, 3).map((login) => (
              <Face key={login} login={login} />
            ))}
            {authors.length > 3 && <span className="pulls-n">+{authors.length - 3}</span>}
          </span>
        )}
        <span className="pulls-seg pulls-layout" role="group" aria-label="Layout">
          <SegButton pressed={layout === 'list'} label="List" onClick={() => setLayout('list')}>
            <ListIcon />
          </SegButton>
          <SegButton pressed={layout === 'board'} label="Board" onClick={() => setLayout('board')}>
            <LanesIcon />
          </SegButton>
        </span>
        <button
          type="button"
          className="pulls-icon pulls-phone-more"
          aria-label="Sort and show"
          aria-haspopup="menu"
          aria-expanded={menu === current}
          onClick={() => setMenu(current)}
        >
          <DotsIcon />
        </button>
      </header>
      {!lists ? (
        <Text as="p" color="secondary" className="pulls-loading">
          {github.error ? '' : 'Loading your pull requests from GitHub…'}
        </Text>
      ) : layout === 'board' ? (
        <>
          <nav className="pulls-tabs" aria-label="Lanes">
            {lanes.map((lane) => (
              <SegButton key={lane.key} pressed={current === lane.key} onClick={() => setPhoneLane(lane.key)}>
                {lane.tab}
                <small>{lane.pulls.length}</small>
              </SegButton>
            ))}
          </nav>
          <div className="pulls-board">
            {lanes.map((lane) => (
              <section
                key={lane.key}
                className={`pulls-lane ${folded.includes(lane.key) ? 'is-folded' : ''} ${current === lane.key ? 'is-current' : ''} is-${lane.key}`}
                aria-label={lane.title}
              >
                <h3 className="pulls-lane-head">
                  <PullMark state={lane.mark} />
                  {lane.title}
                  <span className="pulls-n">{lane.pulls.length}</span>
                  {laneButtons(lane)}
                </h3>
                {menu === lane.key && laneMenu(lane)}
                <div className="pulls-cards">
                  {(lane.key === 'merged' ? lane.pulls.slice(0, MERGED_CARDS) : lane.pulls).map((pull) => (
                    <PullCard key={pull.id} pull={pull} waiting={waiting.has(pull.id)} peek={peeks.get(pull.id)} />
                  ))}
                  {lane.key === 'merged' && lane.pulls.length > MERGED_CARDS && (
                    <button type="button" className="pulls-quiet pulls-show-all" onClick={() => setLayout('list')}>
                      Show all {lane.pulls.length}
                    </button>
                  )}
                  {lane.pulls.length === 0 && <p className="pulls-empty">No pull requests</p>}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className="pulls-list">
          {lanes.map((lane) => (
            <section key={lane.key} className="pulls-group" aria-label={lane.title}>
              <h3 className="pulls-group-head">
                <PullMark state={lane.mark} />
                {lane.title}
                <span className="pulls-n">{lane.pulls.length}</span>
                <span className="pulls-gap" />
                {laneButtons(lane, true)}
              </h3>
              {!folded.includes(lane.key) &&
                lane.pulls.map((pull) => (
                  <PullCard key={pull.id} row pull={pull} waiting={waiting.has(pull.id)} peek={peeks.get(pull.id)} />
                ))}
            </section>
          ))}
        </div>
      )}
      <footer className="pulls-foot">
        <GithubIcon width={16} height={16} />
        <span className="pulls-who">
          @{account.login}
          {github.fetchedAt ? ` · updated ${formatAgo(github.fetchedAt)}` : ''}
        </span>
        {note && <span className="pulls-note">{note}</span>}
        <span className="pulls-gap" />
        {!github.reconnect && (
          <IconButton
            size="sm"
            variant="ghost"
            label="Check GitHub now"
            tooltip="Check GitHub now"
            icon={<RefreshIcon className={refreshing ? 'spin' : undefined} width={16} height={16} />}
            isDisabled={refreshing}
            onClick={() => void refresh()}
          />
        )}
        <Button size="sm" variant="ghost" label="Alerts" onClick={() => setSettings(true)} />
      </footer>
      {opening && (
        <OpenPullDialog
          onClose={(done) => {
            setOpening(false);
            if (done) setNote(done);
          }}
        />
      )}
      {settings && (
        <Dialog title="Pull request alerts" onClose={() => setSettings(false)}>
          <Settings account={account} />
          <Activity events={github.events} />
        </Dialog>
      )}
    </>
  );
}

const SegButton = ({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label?: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button type="button" aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
    {children}
  </button>
);

const MenuChoice = ({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) => (
  <button type="button" role="menuitemradio" aria-checked={checked} onClick={onClick}>
    <span className="pulls-check">
      <CheckIcon />
    </span>
    {label}
  </button>
);

const icon = { ...svg, width: 16, height: 16 };
const CheckIcon = () => (
  <svg {...icon}>
    <polyline points="5 12.5 10 17 19 7" />
  </svg>
);
const FoldIcon = () => (
  <svg {...icon}>
    <polyline points="7 15 12 10 17 15" />
    <line x1="5" y1="19" x2="19" y2="19" />
  </svg>
);
const DotsIcon = () => (
  <svg {...icon}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </svg>
);
const LanesIcon = () => (
  <svg {...icon}>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="11" rx="1" />
    <rect x="17" y="4" width="4" height="7" rx="1" />
  </svg>
);
const ListIcon = () => (
  <svg {...icon}>
    <line x1="8" y1="6" x2="20" y2="6" />
    <line x1="8" y1="12" x2="20" y2="12" />
    <line x1="8" y1="18" x2="20" y2="18" />
    <circle cx="4" cy="6" r="1" />
    <circle cx="4" cy="12" r="1" />
    <circle cx="4" cy="18" r="1" />
  </svg>
);

/** A pull request as a card in a lane, or as a one-line row in the List view. */
function PullCard({
  pull,
  waiting,
  peek,
  row = false,
}: {
  pull: PullRequestDTO;
  waiting: boolean;
  /** Opens the board card this pull request belongs to, when it has one. */
  peek?: () => void;
  row?: boolean;
}) {
  const [sharing, setSharing] = useState(false);
  return (
    <article className={row ? 'pulls-row' : 'pulls-card'}>
      <a
        className="pulls-open"
        href={pull.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-haspopup={peek ? 'dialog' : undefined}
        onClick={(e) => {
          if (!peek) return;
          e.preventDefault();
          peek();
        }}
      >
        <small>
          #{pull.number} · {pull.repo.split('/')[1]}
        </small>
        <strong>{pull.title}</strong>
        {!row && pull.branch && <code>{pull.branch}</code>}
      </a>
      <span className="pulls-foot-row">
        <Face login={pull.author} />
        {waiting && <span className="pull-chip is-yours">Your review</span>}
        <PullChips pull={pull} />
        <span className="pulls-end">
          {pull.review === 'approved' && pull.approvedBy?.length && !pull.mergedAt ? (
            pull.approvedBy.map((login) => <Face key={login} login={login} label={`Approved by ${login}`} />)
          ) : pull.comments > 0 ? (
            <>
              <CommentIcon width={13} height={13} aria-label="Comments" />
              {pull.comments} ·{' '}
            </>
          ) : null}
          {shortAgo(pull.mergedAt ?? pull.updatedAt)}
          <span className="pulls-share">
            <IconButton
              size="sm"
              variant="ghost"
              label="Share to a chat"
              tooltip="Share to a chat"
              icon={<ShareIcon width={14} height={14} />}
              onClick={() => setSharing(true)}
            />
          </span>
        </span>
      </span>
      {sharing && <SharePullDialog pull={pull} onClose={() => setSharing(false)} />}
    </article>
  );
}

/** Picks a branch with no pull request yet and opens a draft from it on GitHub, through the server (D-033). */
function OpenPullDialog({ onClose }: { onClose: (done?: string) => void }) {
  const [branches, setBranches] = useState<BranchChoiceDTO[] | null>(null);
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.githubBranches().then(setBranches, (err: Error) => {
      setBranches([]);
      setError(err.message);
    });
  }, []);

  const repos = new Set(branches?.map((b) => b.repo)).size;

  async function submit() {
    const choice = branches?.[picked];
    if (!choice) return;
    setBusy(true);
    setError('');
    try {
      await api.openPull({ repo: choice.repo, base: choice.base, branch: choice.branch, title: choice.title });
      // The server polled after opening it, so this only fetches what it found.
      await refreshGithub();
      onClose(`Opened a draft pull request from ${choice.branch}.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Open a pull request" onClose={() => onClose()}>
      <Text as="p" color="secondary">
        Pull requests come from GitHub. Pick a branch whose card has none yet.
      </Text>
      {!branches ? (
        <Text as="p" color="secondary">
          Loading branches…
        </Text>
      ) : branches.length === 0 && !error ? (
        <Text as="p" color="secondary">
          Every recent branch already has a pull request.
        </Text>
      ) : (
        <span className="pulls-branches" role="radiogroup" aria-label="Branch">
          {branches.map((b, i) => (
            <label key={`${b.repo}:${b.branch}`} className="pulls-branch">
              <input type="radio" name="branch" checked={picked === i} onChange={() => setPicked(i)} />
              <span>
                {b.branch}
                <small>
                  {b.title}
                  {repos > 1 && ` · ${b.repo}`}
                </small>
              </span>
            </label>
          ))}
        </span>
      )}
      {error && (
        <Text as="p" weight="semibold">
          {error}
        </Text>
      )}
      <span className="pulls-dialog-foot">
        <Button label="Cancel" onClick={() => onClose()} />
        <Button
          variant="primary"
          label="Open as draft"
          isDisabled={busy || !branches?.length}
          onClick={() => void submit()}
        />
      </span>
    </Dialog>
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
