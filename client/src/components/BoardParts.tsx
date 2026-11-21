// What the board shows around its cards: the cards that wait for the user, and a proposal's face.
import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Avatar } from './Avatar';
import { BellIcon, FileIcon } from './icons';
import { Tag, type Tone } from './PullTags';

/** A person as a card shows them: their name, and the number their avatar's color follows. */
export type Person = { name: string; seed: number };

/** The Roadmap's lanes, side by side; under 760 pixels they stack. */
export const BoardLanes = ({ children }: { children: ReactNode }) => <div className="board-lanes">{children}</div>;

/** One lane, such as Ready, Running or In review: its name, how many cards it holds, and their faces. */
export function BoardLane({ name, count, children }: { name: string; count: number; children?: ReactNode }) {
  return (
    <section className="board-lane">
      <h3>
        {name} <small>{count}</small>
      </h3>
      {children}
    </section>
  );
}

/** A folding list under the lanes, such as Open or Done, or a group of decisions. */
export function BoardDrawer({
  name,
  count,
  isOpen,
  onToggle,
  children,
}: {
  name: string;
  count: number;
  isOpen: boolean;
  onToggle?: (isOpen: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <details className="board-group" open={isOpen} onToggle={(e) => onToggle?.(e.currentTarget.open)}>
      <summary>
        {name} <small>{count}</small>
      </summary>
      {children}
    </details>
  );
}

/**
 * A card's face in its lane or list. A Roadmap card shows its owner, its title and whose move it
 * is; a decision shows its id and its status. A click opens the card's peek.
 */
export function CardFace({
  title,
  id,
  owner,
  status,
  reviewers,
  tag,
  action,
  isWaiting,
  isLocked,
  onOpen,
  children,
}: {
  title: string;
  /** Its id, such as D-12, which a face with no `owner` prop leads with. */
  id?: string;
  /** The Roadmap card's owner, or null for one with none. Left out, the face leads with `id`. */
  owner?: Person | null;
  /** At its right: whose move it is, or a decision's status. */
  status?: string;
  /** In place of `status` for a card in review: each reviewer, in the color of their verdict. */
  reviewers?: Array<Person & { tone: Tone; label: string }>;
  /** Where its run stands, or why it waits for the user. */
  tag?: { tone: Tone; label: string };
  /** A button beside the face, such as Pick. */
  action?: ReactNode;
  /** It waits for someone, which marks its edge. */
  isWaiting?: boolean;
  /** Someone edits it. */
  isLocked?: boolean;
  onOpen: () => void;
  /** Warnings under the face. */
  children?: ReactNode;
}) {
  const face = owner !== undefined;
  const head = (
    <button className={`board-card-head ${face ? 'board-face' : ''}`} onClick={onOpen} aria-haspopup="dialog">
      {!face ? (
        id && <span className="board-card-id">{id}</span>
      ) : owner ? (
        <Avatar name={owner.name} seed={owner.seed} size={24} />
      ) : (
        <span className="board-no-owner" role="img" title="No owner" aria-label="No owner" />
      )}
      <strong>{title}</strong>
      {reviewers?.length ? (
        <span className="board-reviewers">
          {reviewers.map((r) => (
            <span key={r.seed} className={`board-reviewer tag-${r.tone}`} role="img" title={`${r.name}: ${r.label}`} aria-label={`${r.name}: ${r.label}`}>
              <Avatar name={r.name} seed={r.seed} size={20} />
            </span>
          ))}
        </span>
      ) : (
        status && <span className="board-card-status">{status}</span>
      )}
      {tag && <Tag tone={tag.tone}>{tag.label}</Tag>}
    </button>
  );
  return (
    <article className={`board-card ${isLocked ? 'is-locked' : ''} ${isWaiting ? 'is-waiting' : ''}`}>
      {action ? (
        <div className="board-face-row">
          {head}
          {action}
        </div>
      ) : (
        head
      )}
      {children}
    </article>
  );
}

/** The cards and drafts that wait for the user, above the lanes: each opens where they act on it (R-047). */
export function NeedsRow({ items }: { items: Array<{ key: string; label: string; reason: string; onOpen: () => void }> }) {
  return (
    <Stack className="board-needs" direction="horizontal" wrap="wrap" align="center" gap={1} padding={1} isScrollable>
      <BellIcon width={16} height={16} />
      <Text weight="semibold">Needs you</Text>
      {items.map((item) => (
        <Button key={item.key} size="sm" label={item.label} endContent={<Tag tone="warn">{item.reason}</Tag>} onClick={item.onOpen} />
      ))}
    </Stack>
  );
}

/** A proposal's dashed face: a draft that is not a card until its owner adds it, which its peek does (R-047, D-104). */
export function ProposalFace({ title, tag, repo, onOpen }: { title: string; tag: string; repo: string; onOpen: () => void }) {
  return (
    <article className="board-card is-proposal board-face-row">
      <button className="board-card-head board-face" onClick={onOpen} aria-haspopup="dialog">
        <FileIcon width={18} height={18} />
        <strong>{title}</strong>
        <span className="board-card-status">{repo}</span>
        <Tag tone="info">{tag}</Tag>
      </button>
      <Button size="sm" label="Add to board" onClick={onOpen} />
    </article>
  );
}
