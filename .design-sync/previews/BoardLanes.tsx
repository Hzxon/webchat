import { BoardLane, BoardLanes, CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const rafi = { name: 'Rafi Hart', seed: 3 };
const open = () => undefined;
const add = [{ label: 'New idea', onSelect: open }];
const menu = [{ label: 'Fold lane', onSelect: open }];
const pick = (
  <button type="button" className="board-small-button" onClick={open}>
    Pick
  </button>
);

// The Roadmap's four lanes, side by side.
export const Roadmap = () => (
  <div style={{ display: 'flex', flexDirection: 'column', width: 1040, height: 420 }}>
    <BoardLanes>
      <BoardLane name="Idea" kind="idea" count={1} add={add} menu={menu}>
        <CardFace id="R-44" title="Voice notes in chats" text="Hold to record. The note is encrypted in the browser like text." owner={null} onOpen={open} />
      </BoardLane>
      <BoardLane name="Ready" kind="ready" count={1} add={add} menu={menu}>
        <CardFace id="R-40" title="Export a chat as a file" text="Download a chat as Markdown, decrypted in the browser." owner={null} action={pick} onOpen={open} />
      </BoardLane>
      <BoardLane name="Running" kind="running" count={1} menu={menu}>
        <CardFace id="K-12" title="Drop bad push keys" text="A 410 from the push service drops the key." owner={ann} chips={[{ tone: 'warn', label: 'Asking you' }]} pull={{ number: 214, state: 'draft' }} isWaiting onOpen={open} />
      </BoardLane>
      <BoardLane name="In review" kind="review" count={1} menu={menu}>
        <CardFace id="R-31" title="Pin messages in channels" text="Pins are encrypted like messages." owner={rafi} pull={{ number: 205, state: 'review' }} onOpen={open} />
      </BoardLane>
    </BoardLanes>
  </div>
);
