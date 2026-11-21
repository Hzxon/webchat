import { BoardDrawer, BoardLane, BoardLanes, BoardTheme, Button, CardFace, NeedsRow, ProposalFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const bo = { name: 'Bo Tan', seed: 2 };
const open = () => undefined;

const board = (
  <div style={{ width: 900, padding: 16, background: 'var(--panel)', color: 'var(--text)' }}>
    <NeedsRow
      items={[
        { key: 'r12', label: 'R-12 Search in channels', reason: 'Asking you', onOpen: open },
        { key: 'p1', label: 'Bark banner for iOS 15', reason: 'Proposal to add', onOpen: open },
      ]}
    />
    <BoardLanes>
      <BoardLane name="Ready" count={1}>
        <CardFace title="Export a chat as a file" owner={ann} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
      </BoardLane>
      <BoardLane name="Running" count={1}>
        <CardFace title="Search in channels" owner={ann} status="Ann's agent" tag={{ tone: 'warn', label: 'Asking you' }} isWaiting onOpen={open} />
      </BoardLane>
      <BoardLane name="In review" count={1}>
        <CardFace title="Draft cut short at 4,000 characters" owner={bo} reviewers={[{ ...ann, tone: 'ok', label: 'Approved' }]} onOpen={open} />
      </BoardLane>
    </BoardLanes>
    <BoardDrawer name="Open" count={1} isOpen>
      <ProposalFace title="Bark banner for iOS 15" tag="Proposal" repo="capstone" onOpen={open} />
    </BoardDrawer>
  </div>
);

// The whole board in WebChat's look: the row of what waits, the lanes, the Open drawer. Dark is
// `mode="dark"` on the one BoardTheme at the page's root: the palette belongs to the whole page.
export const Light = () => <BoardTheme>{board}</BoardTheme>;
