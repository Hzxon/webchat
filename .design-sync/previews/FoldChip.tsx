import { FoldChip } from '@webchat/board-kit';

const open = () => undefined;

// A folded lane in the board's header; a click unfolds it.
export const Folded = () => (
  <div style={{ display: 'flex', gap: 8 }}>
    <FoldChip name="Idea" kind="idea" count={3} onUnfold={open} />
    <FoldChip name="In review" kind="review" count={1} onUnfold={open} />
  </div>
);
