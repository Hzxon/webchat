import { Button, CardFace } from '@webchat/board-kit';

const ann = { name: 'Ann Lee', seed: 1 };
const bo = { name: 'Bo Tan', seed: 2 };
const cy = { name: 'Cy Moreno', seed: 5 };
const lane = { width: 300 } as const;
const open = () => undefined;

// A Ready card: its owner, its title, and Pick beside it.
export const Ready = () => (
  <div style={lane}>
    <CardFace title="Export a chat as a file" owner={ann} action={<Button size="sm" label="Pick" onClick={open} />} onOpen={open} />
  </div>
);

// A card an agent runs: who runs it at the right, and where the run stands.
export const Running = () => (
  <div style={lane}>
    <CardFace title="Search in channels" owner={ann} status="Ann's agent" tag={{ tone: 'info', label: 'Working…' }} onOpen={open} />
  </div>
);

// A card that waits for the user: the warning tag and the marked edge.
export const NeedsYou = () => (
  <div style={lane}>
    <CardFace title="Read receipts" owner={ann} status="Ann's agent" tag={{ tone: 'warn', label: 'Plan ready' }} isWaiting onOpen={open} />
  </div>
);

// A card in review: each reviewer in the color of their verdict.
export const InReview = () => (
  <div style={lane}>
    <CardFace
      title="Draft cut short at 4,000 characters"
      owner={bo}
      reviewers={[
        { ...ann, tone: 'ok', label: 'Approved' },
        { ...cy, tone: 'warn', label: 'Review required' },
      ]}
      onOpen={open}
    />
  </div>
);

// A card nobody owns yet, and one that a teammate is editing.
export const NoOwnerAndLocked = () => (
  <div style={{ ...lane, display: 'grid', gap: 8 }}>
    <CardFace title="Push fails on iOS 15" owner={null} status="Open" onOpen={open} />
    <CardFace title="Dark mode for exports" owner={cy} status="Idea" isLocked onOpen={open} />
  </div>
);

// A decision's face: its id, its title and its status.
export const Decision = () => (
  <div style={{ width: 520 }}>
    <CardFace id="D-12" title="No connection stays open" status="Accepted 2026-10-30 in #4" onOpen={open} />
  </div>
);
