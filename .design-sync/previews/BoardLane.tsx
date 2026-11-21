import { BoardLane, Button, CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const bo = { name: 'Bo Tan', seed: 2 };
const open = () => undefined;
const lane = { width: 300 } as const;

// A lane with its cards' faces; the number is how many it holds.
export const Ready = () => (
  <div style={lane}>
    <BoardLane name="Ready" count={2}>
      <CardFace title="Export a chat as a file" owner={ann} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
      <CardFace title="Push fails on iOS 15" owner={bo} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
    </BoardLane>
  </div>
);

// An empty lane keeps its heading.
export const Empty = () => (
  <div style={lane}>
    <BoardLane name="In review" count={0} />
  </div>
);
