// The project board's parts as a library, for the design system (.design-sync/). Each part is the
// app's own component, exported from where the app keeps it; only BoardTheme is written here.
// The styles come in the app's order: its layers first, then Astryx's (client/src/main.tsx).
import '../../../client/src/layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';

export { BoardTheme } from './BoardTheme';
export {
  BoardGroup,
  BoardLane,
  BoardLanes,
  BoardMenu,
  CardFace,
  CardRow,
  FoldChip,
  ProposalFace,
  PullNumber,
  StateChip,
} from '../../../client/src/components/BoardParts';
export { CardPeek } from '../../../client/src/components/CardPeek';
export { RunAsk, RunPanel, RunStep } from '../../../client/src/components/RunPanel';
export { Tag } from '../../../client/src/components/PullTags';
export { Avatar } from '../../../client/src/components/Avatar';
export { Markdown } from '../../../client/src/components/Markdown';
// The Astryx controls the board's parts are built with, under WebChat's theme.
export { Banner } from '@astryxdesign/core/Banner';
export { Button } from '@astryxdesign/core/Button';
export { IconButton } from '@astryxdesign/core/IconButton';
export { Text } from '@astryxdesign/core/Text';
export {
  FileIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from '../../../client/src/components/icons';
