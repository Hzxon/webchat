import { Tag } from '@webchat/board-kit';

const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;

// The five tones, each with a word the board uses it for.
export const Tones = () => (
  <div style={row}>
    <Tag tone="ok">Approved</Tag>
    <Tag tone="warn">Plan ready</Tag>
    <Tag tone="danger">Couldn't finish</Tag>
    <Tag tone="info">Proposal</Tag>
    <Tag tone="muted">Not checked by an agent yet</Tag>
  </div>
);

// What a run's tag says as it goes.
export const RunStates = () => (
  <div style={row}>
    <Tag tone="muted">Waiting for the agent</Tag>
    <Tag tone="info">Working…</Tag>
    <Tag tone="warn">Asking you</Tag>
    <Tag tone="ok">Draft ready</Tag>
  </div>
);
