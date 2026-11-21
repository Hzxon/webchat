import { BoardDrawer, CardFace, ProposalFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const open = () => undefined;
const board = { width: 760 } as const;

// The Open drawer under the lanes: cards nobody marked ready yet, and a proposal first.
export const Open = () => (
  <div style={board}>
    <BoardDrawer name="Open" count={3} isOpen>
      <ProposalFace title="Bark banner for iOS 15" tag="Proposal" repo="capstone" onOpen={open} />
      <CardFace title="Dark mode for exports" owner={ann} status="Idea" onOpen={open} />
      <CardFace title="Unread count is wrong after a reload" owner={null} status="Open" onOpen={open} />
    </BoardDrawer>
  </div>
);

// Folded, as Done starts.
export const Folded = () => (
  <div style={board}>
    <BoardDrawer name="Done" count={14} isOpen={false} />
  </div>
);

// A group of decisions.
export const Decisions = () => (
  <div style={board}>
    <BoardDrawer name="Accepted" count={2} isOpen>
      <CardFace id="D-12" title="No connection stays open" status="Accepted 2026-10-30 in #4" onOpen={open} />
      <CardFace id="D-9" title="The server never sees what users write" status="Accepted 2026-10-28 in #2" onOpen={open} />
    </BoardDrawer>
  </div>
);
