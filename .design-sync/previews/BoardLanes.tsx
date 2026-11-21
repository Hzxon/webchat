import { BoardLane, BoardLanes, Button, CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const bo = { name: 'Bo Tan', seed: 2 };
const cy = { name: 'Cy Moreno', seed: 5 };
const open = () => undefined;

// The Roadmap's three lanes, side by side.
export const Roadmap = () => (
  <div style={{ width: 900 }}>
    <BoardLanes>
      <BoardLane name="Ready" count={2}>
        <CardFace title="Export a chat as a file" owner={ann} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
        <CardFace title="Push fails on iOS 15" owner={bo} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
      </BoardLane>
      <BoardLane name="Running" count={2}>
        <CardFace title="Search in channels" owner={ann} status="Ann's agent" tag={{ tone: 'warn', label: 'Asking you' }} isWaiting onOpen={open} />
        <CardFace title="Read receipts" owner={cy} status="Cy" onOpen={open} />
      </BoardLane>
      <BoardLane name="In review" count={1}>
        <CardFace
          title="Draft cut short at 4,000 characters"
          owner={bo}
          reviewers={[{ ...ann, tone: 'ok', label: 'Approved' }]}
          onOpen={open}
        />
      </BoardLane>
    </BoardLanes>
  </div>
);
