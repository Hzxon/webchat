import { BoardLane, CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const open = () => undefined;
const lane = { display: 'flex', width: 300, height: 360 } as const;
const menu = [
  { heading: 'Sort by' },
  { label: 'Newest', isChecked: true, onSelect: open },
  { label: 'Oldest', isChecked: false, onSelect: open },
  null,
  { label: 'Fold lane', onSelect: open },
];

// A lane: its icon, name and count, then + and ⋯, over its cards.
export const Ready = () => (
  <div style={lane}>
    <BoardLane name="Ready" kind="ready" count={2} add={[{ label: 'New idea', onSelect: open }]} menu={menu}>
      <CardFace id="R-40" title="Export a chat as a file" owner={null} onOpen={open} />
      <CardFace id="K-14" title="Message search is slow on long chats" owner={ann} onOpen={open} />
    </BoardLane>
  </div>
);

// The finished lane, which its head's button hides.
export const Done = () => (
  <div style={lane}>
    <BoardLane name="Done" kind="done" count={1} onHide={open}>
      <CardFace id="K-9" title="Cap push payloads at 3,000 bytes" owner={ann} pull={{ number: 198, state: 'merged' }} onOpen={open} />
    </BoardLane>
  </div>
);
