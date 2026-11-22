import { BoardMenu } from '@webchat/board-kit';

const pick = () => undefined;

// A lane's menu: how it sorts, whose cards it shows, and folding it. At phone width it is a sheet.
export const LaneMenu = () => (
  <div style={{ position: 'relative', width: 260, height: 400, display: 'flex', justifyContent: 'flex-end' }}>
    <span className="board-menu-anchor">
      <BoardMenu
        label="Ready lane"
        onClose={pick}
        entries={[
          { heading: 'Sort by' },
          { label: 'Newest', isChecked: true, onSelect: pick },
          { label: 'Oldest', isChecked: false, onSelect: pick },
          { label: 'Owner', isChecked: false, onSelect: pick },
          { label: 'Id', isChecked: false, onSelect: pick },
          null,
          { heading: 'Show' },
          { label: 'All cards', isChecked: true, onSelect: pick },
          { label: 'Mine', isChecked: false, onSelect: pick },
          { label: 'No owner', isChecked: false, onSelect: pick },
          null,
          { label: 'Fold lane', onSelect: pick },
        ]}
      />
    </span>
  </div>
);
