import { BoardGroup, CardRow } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const open = () => undefined;

// The List view: a lane as a group of one-line rows.
export const Running = () => (
  <div style={{ width: 760 }}>
    <BoardGroup name="Running" kind="running" count={2}>
      <CardRow id="K-12" title="Drop bad push keys" owner={ann} chips={[{ tone: 'warn', label: 'Asking you' }]} pull={{ number: 214, state: 'draft' }} isWaiting onOpen={open} />
      <CardRow id="R-35" title="Search in channels" owner={ann} pull={{ number: 209, state: 'draft' }} onOpen={open} />
    </BoardGroup>
  </div>
);
