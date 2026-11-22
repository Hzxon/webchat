// The board's parts: tinted lanes of white cards, the same lanes as groups of rows, a lane's menu,
// and a proposal's face. Each takes plain values; BoardView fills them from the board's docs.
import { useState, useSyncExternalStore, type ReactNode, type SVGProps } from 'react';
import { CloseIcon, FileIcon, PlusIcon, PullRequestIcon } from './icons';
import type { Tone } from './PullTags';

/** A person as a card shows them: their name, and the number their avatar's color follows. */
export type Person = { name: string; seed: number };
/** Where a card stands, which picks its lane's icon. */
export type LaneKind = 'idea' | 'ready' | 'running' | 'review' | 'done' | 'dropped';
/** A state chip: only the agent's question and a failure are colored, the rest are muted. */
export type Chip = { tone: Tone; label: string };
/** A card's pull request: a draft while it runs, ready for review, or merged. */
export type PullMark = { number: number; state: 'draft' | 'review' | 'merged'; href?: string };
/** A menu's entry: a heading over a group, a choice, or null for a line between groups. */
export type MenuEntry = { heading: string } | { label: string; isChecked?: boolean; onSelect: () => void } | null;

// The width of the narrow layout in styles.css, where the board shows one lane and the peek fills the screen.
const narrow = matchMedia('(max-width: 760px)');
const onNarrow = (changed: () => void) => {
  narrow.addEventListener('change', changed);
  return () => narrow.removeEventListener('change', changed);
};
export const useNarrow = () => useSyncExternalStore(onNarrow, () => narrow.matches);

const Svg = ({ children, ...p }: SVGProps<SVGSVGElement>) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    {children}
  </svg>
);

const LANE_ICONS: Record<LaneKind, ReactNode> = {
  idea: <circle cx="12" cy="12" r="9" strokeDasharray="2.4 3" />,
  ready: <circle cx="12" cy="12" r="9" />,
  running: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7a5 5 0 0 1 0 10z" fill="currentColor" stroke="none" />
    </>
  ),
  review: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7a5 5 0 1 1-5 5h5z" fill="currentColor" stroke="none" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12.5 11 15 16 9.5" />
    </>
  ),
  dropped: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
};

/** A lane's state as a small circle: dashed for an idea, filling as the work goes, a check when done. */
export const LaneIcon = ({ kind }: { kind: LaneKind }) => (
  <span className={`lane-icon is-${kind}`}>
    <Svg>{LANE_ICONS[kind]}</Svg>
  </span>
);

export const DotsIcon = () => (
  <Svg>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Svg>
);
export const ListIcon = () => (
  <Svg>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h0M4 12h0M4 18h0" />
  </Svg>
);
export const LanesIcon = () => (
  <Svg>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="11" rx="1" />
    <rect x="17" y="4" width="4" height="7" rx="1" />
  </Svg>
);
const CheckIcon = () => (
  <Svg>
    <polyline points="5 12.5 10 17 19 7" />
  </Svg>
);

const PULL_TITLES = { draft: 'Draft', review: 'Ready for review', merged: 'Merged' };
/** A pull request's mark and number: dashed while a draft, solid in review, in the success color once merged. */
/** `title` follows the number, as the peek's facts name it. */
export function PullNumber({ pull, title }: { pull: PullMark; title?: string }) {
  const icon = (
    <span className={`pull-mark is-${pull.state}`} title={PULL_TITLES[pull.state]}>
      {pull.state === 'merged' ? (
        <Svg>
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </Svg>
      ) : (
        <PullRequestIcon width={16} height={16} strokeDasharray={pull.state === 'draft' ? '3 2.5' : undefined} />
      )}
    </span>
  );
  return (
    <span className="board-pull">
      {icon}
      {pull.href ? (
        <a href={pull.href} target="_blank" rel="noopener noreferrer">
          #{pull.number}
          {title && ` ${title}`}
        </a>
      ) : (
        `#${pull.number}${title ? ` ${title}` : ''}`
      )}
    </span>
  );
}

/** A state chip, such as "Asking you". */
export const StateChip = ({ chip }: { chip: Chip }) => <span className={`board-chip is-${chip.tone}`}>{chip.label}</span>;

// A person's face on the board: their initials in a soft tint, the tint following their seed.
const TINTS = ['accent', 'warn', 'ok', 'muted'];
const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
};

/** A person as a round face with their initials, as the board, its header and the peek's facts show them. */
export const Face = ({ person, size = 22 }: { person: Person; size?: number }) => (
  <span
    className={`board-face is-${TINTS[person.seed % TINTS.length]}`}
    role="img"
    title={person.name}
    aria-label={person.name}
    style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
  >
    {initials(person.name)}
  </span>
);

/** A card's owner, or a dashed circle for a card nobody owns yet. */
const Owner = ({ owner }: { owner: Person | null }) =>
  owner ? (
    <Face person={owner} />
  ) : (
    <span className="board-no-owner" role="img" title="No owner" aria-label="No owner" />
  );

/** A menu that floats under its button; at phone width it is a sheet from the bottom. */
export function BoardMenu({ label, entries, onClose }: { label: string; entries: MenuEntry[]; onClose: () => void }) {
  const first = entries.findIndex((e) => e && !('heading' in e));
  return (
    <>
      <button type="button" className="board-menu-back" aria-label="Close" onClick={onClose} />
      <div className="board-menu" role="menu" aria-label={label} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <span className="board-menu-grab" aria-hidden="true" />
        {entries.map((entry, i) =>
          entry === null ? (
            <hr key={i} />
          ) : 'heading' in entry ? (
            <span key={i} className="board-menu-heading">
              {entry.heading}
            </span>
          ) : (
            <button
              key={i}
              type="button"
              role={entry.isChecked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={entry.isChecked}
              autoFocus={i === first}
              onClick={() => {
                onClose();
                entry.onSelect();
              }}
            >
              <span className="board-menu-check">{entry.isChecked && <CheckIcon />}</span>
              {entry.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** A button that opens a menu under it. With one choice it makes it at once. */
function MenuButton({ label, icon, entries }: { label: string; icon: ReactNode; entries: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const only = entries.length === 1 && entries[0] && 'onSelect' in entries[0] ? entries[0] : undefined;
  return (
    <span className="board-menu-anchor">
      <button
        type="button"
        className="board-icon-button"
        aria-label={only?.label ?? label}
        title={only?.label ?? label}
        aria-haspopup={only ? undefined : 'menu'}
        aria-expanded={only ? undefined : open}
        onClick={() => (only ? only.onSelect() : setOpen(true))}
      >
        {icon}
      </button>
      {open && <BoardMenu label={label} entries={entries} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** The lanes side by side; the row scrolls sideways when they do not fit. */
export const BoardLanes = ({ children }: { children: ReactNode }) => <div className="board-lanes">{children}</div>;

/** One lane, such as Ready or Running: a tinted column with its icon, name and count, its new-card button and its menu. */
export function BoardLane({
  name,
  kind,
  count,
  add,
  menu,
  onHide,
  children,
}: {
  name: string;
  kind: LaneKind;
  count: number;
  /** The new cards it can start: a kind, or a choice of kinds. */
  add?: MenuEntry[];
  menu?: MenuEntry[];
  /** Marks the finished lane, which this button in its head takes away. */
  onHide?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className={`board-lane${onHide ? ' is-finished' : ''}`} aria-label={name}>
      <h3 className="board-lane-head">
        <LaneIcon kind={kind} />
        {name}
        <span className="board-count">{count}</span>
        {add && <MenuButton label={`New card in ${name}`} icon={<PlusIcon width={16} height={16} />} entries={add} />}
        {menu && <MenuButton label={`More for ${name}`} icon={<DotsIcon />} entries={menu} />}
        {onHide && (
          <button type="button" className="board-icon-button" aria-label={`Hide ${name}`} title={`Hide ${name}`} onClick={onHide}>
            <CloseIcon width={16} height={16} />
          </button>
        )}
      </h3>
      <div className="board-lane-cards">{children}</div>
    </section>
  );
}

/** A folded lane as a dashed chip in the board's header, which takes no lane's width; a click unfolds it. */
export const FoldChip = ({ name, kind, count, onUnfold }: { name: string; kind: LaneKind; count: number; onUnfold: () => void }) => (
  <button type="button" className="board-fold-chip" aria-label={`Unfold ${name}`} title={`Unfold ${name}`} onClick={onUnfold}>
    <LaneIcon kind={kind} />
    {name}
    <span className="board-count">{count}</span>
  </button>
);

/** One lane as a group of one-line rows, for the List view. */
export const BoardGroup = ({ name, kind, count, add, children }: { name: string; kind: LaneKind; count: number; add?: MenuEntry[]; children?: ReactNode }) => (
  <section className="board-group" aria-label={name}>
    <h3 className="board-group-head">
      <LaneIcon kind={kind} />
      {name}
      <span className="board-count">{count}</span>
      {add && <MenuButton label={`New card in ${name}`} icon={<PlusIcon width={16} height={16} />} entries={add} />}
    </h3>
    {children}
  </section>
);

type FaceProps = {
  title: string;
  /** Its id, such as R-12. */
  id?: string;
  /** The Roadmap card's owner, or null for one with none; a decision leaves it out. */
  owner?: Person | null;
  /** Where its run stands, or why it waits for the user. */
  chips?: Chip[];
  pull?: PullMark;
  /** A button beside the card's open button, such as Pick. */
  action?: ReactNode;
  /** Its agent waits for the user's answer, which tints it amber. */
  isWaiting?: boolean;
  /** Someone edits it. */
  isLocked?: boolean;
  onOpen: () => void;
  /** Warnings under the face. */
  children?: ReactNode;
};

/** What a face and a row show under the title: the owner, the state chips, the pull request and the action. */
const Foot = ({ owner, chips, pull, action }: Pick<FaceProps, 'owner' | 'chips' | 'pull' | 'action'>) =>
  owner !== undefined || chips?.length || pull || action ? (
    <span className="board-card-foot">
      {owner !== undefined && <Owner owner={owner} />}
      {chips?.map((chip) => <StateChip key={chip.label} chip={chip} />)}
      {pull && <PullNumber pull={pull} />}
      {action && <span className="board-card-action">{action}</span>}
    </span>
  ) : null;

/**
 * A card in its lane: white, with its id, a bold title, three lines of its text, and under them its
 * owner, its state chips and its pull request. Its button opens the card's peek; an action such as
 * Pick sits outside that button.
 */
export function CardFace({ title, id, text, isWaiting, isLocked, onOpen, children, ...foot }: FaceProps & { text?: string }) {
  return (
    <article className={`board-card${isWaiting ? ' is-waiting' : ''}${isLocked ? ' is-locked' : ''}`}>
      <button type="button" className="board-card-open" onClick={onOpen} aria-haspopup="dialog">
        {id && <small>{id}</small>}
        <strong>{title}</strong>
        {text && <span className="board-card-text">{text}</span>}
      </button>
      <Foot {...foot} />
      {children}
    </article>
  );
}

/** A card as one row of the List view: its id and title, then the same owner, chips and pull request as its face. */
export function CardRow({ title, id, isWaiting, isLocked, onOpen, children, ...foot }: FaceProps) {
  return (
    <div className={`board-row${isWaiting ? ' is-waiting' : ''}${isLocked ? ' is-locked' : ''}`}>
      <button type="button" className="board-row-open" onClick={onOpen} aria-haspopup="dialog">
        {id && <small>{id}</small>}
        <strong>{title}</strong>
      </button>
      <Foot {...foot} />
      {children}
    </div>
  );
}

/** A proposal's dashed face: a draft that is not a card until its owner adds it, which its peek does (R-047, D-104). */
export function ProposalFace({ title, tag, repo, onOpen }: { title: string; tag: string; repo: string; onOpen: () => void }) {
  return (
    <article className="board-card is-proposal">
      <button type="button" className="board-card-open" onClick={onOpen} aria-haspopup="dialog">
        <small>
          <FileIcon width={14} height={14} /> {repo}
        </small>
        <strong>{title}</strong>
      </button>
      <span className="board-card-foot">
        <StateChip chip={{ tone: 'muted', label: tag }} />
        <span className="board-card-action">
          <button type="button" className="board-small-button" onClick={onOpen}>
            Add to board
          </button>
        </span>
      </span>
    </article>
  );
}
