import { HistoryIcon, IconButton, PencilIcon, PlayIcon, StopIcon, TrashIcon } from '@webchat/board-kit';

const row = { display: 'flex', gap: 4, alignItems: 'center' } as const;
const act = () => undefined;

// A card's buttons in its peek's header: ghost, small, each named for a screen reader.
export const CardTools = () => (
  <div style={row}>
    <IconButton variant="ghost" size="sm" label="Edit card" tooltip="Edit" icon={<PencilIcon width={18} height={18} />} onClick={act} />
    <IconButton variant="ghost" size="sm" label="Card history" tooltip="History" icon={<HistoryIcon width={18} height={18} />} onClick={act} />
    <IconButton variant="ghost" size="sm" label="Run with your agent" tooltip="Run with your agent" icon={<PlayIcon width={18} height={18} />} onClick={act} />
    <IconButton variant="ghost" size="sm" label="Delete card" tooltip="Delete" icon={<TrashIcon width={18} height={18} />} onClick={act} />
  </div>
);

// While a run goes, Stop takes the place of Run; a button with nothing to do is disabled.
export const States = () => (
  <div style={row}>
    <IconButton variant="ghost" size="sm" label="Stop the run" tooltip="Stop" icon={<StopIcon width={18} height={18} />} onClick={act} />
    <IconButton variant="ghost" size="sm" label="Edit card" icon={<PencilIcon width={18} height={18} />} isDisabled onClick={act} />
    <IconButton variant="primary" label="Send" icon={<PlayIcon width={18} height={18} />} onClick={act} />
  </div>
);
