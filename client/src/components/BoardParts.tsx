// What the board shows around its cards: the cards that wait for the user, and a proposal's face.
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { BellIcon, FileIcon } from './icons';
import { Tag } from './PullTags';

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
