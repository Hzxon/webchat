import { NeedsRow } from '@webchat/board-kit';

const open = () => undefined;
const board = { width: 760 } as const;

// One card waits for the user.
export const OneCard = () => (
  <div style={board}>
    <NeedsRow items={[{ key: 'r12', label: 'R-12 Search in channels', reason: 'Asking you', onOpen: open }]} />
  </div>
);

// Several wait, questions first; a proposal comes last.
export const Several = () => (
  <div style={board}>
    <NeedsRow
      items={[
        { key: 'r12', label: 'R-12 Search in channels', reason: 'Asking you', onOpen: open },
        { key: 'r9', label: 'R-9 Read receipts', reason: 'Plan ready', onOpen: open },
        { key: 'k3', label: 'K-3 Draft cut short', reason: 'Asks for your review', onOpen: open },
        { key: 'p1', label: 'Bark banner for iOS 15', reason: 'Proposal to add', onOpen: open },
      ]}
    />
  </div>
);

// On a phone the row wraps, and a long title is cut.
export const Narrow = () => (
  <div style={{ width: 340 }}>
    <NeedsRow
      items={[
        { key: 'r2', label: 'R-2 Dark mode for exported chats', reason: 'Asks you to mark it ready', onOpen: open },
        { key: 'r9', label: 'R-9 Read receipts', reason: 'Plan ready', onOpen: open },
      ]}
    />
  </div>
);
