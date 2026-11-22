import { BoardLane, BoardLanes, BoardTheme, CardFace, ProposalFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const rafi = { name: 'Rafi Hart', seed: 3 };
const open = () => undefined;
const pick = (
  <button type="button" className="board-small-button" onClick={open}>
    Pick
  </button>
);

const board = (
  <div style={{ display: 'flex', flexDirection: 'column', width: 960, height: 400, background: 'var(--panel)', color: 'var(--text)' }}>
    <BoardLanes>
      <BoardLane name="Idea" kind="idea" count={1}>
        <ProposalFace title="Bark banner for iOS 15" tag="Proposal" repo="capstone" onOpen={open} />
      </BoardLane>
      <BoardLane name="Ready" kind="ready" count={1}>
        <CardFace id="R-40" title="Export a chat as a file" owner={null} action={pick} onOpen={open} />
      </BoardLane>
      <BoardLane name="Running" kind="running" count={1}>
        <CardFace id="K-12" title="Drop bad push keys" owner={ann} chips={[{ tone: 'warn', label: 'Asking you' }]} pull={{ number: 214, state: 'draft' }} isWaiting onOpen={open} />
      </BoardLane>
      <BoardLane name="In review" kind="review" count={1}>
        <CardFace id="R-31" title="Pin messages in channels" owner={rafi} pull={{ number: 205, state: 'review' }} onOpen={open} />
      </BoardLane>
    </BoardLanes>
  </div>
);

// The whole board in WebChat's look: tinted lanes of white cards, one accent. Dark is
// `mode="dark"` on the one BoardTheme at the page's root: the palette belongs to the whole page.
export const Light = () => <BoardTheme>{board}</BoardTheme>;
