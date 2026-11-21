import { Text } from '@webchat/board-kit';

const column = { display: 'grid', gap: 6, width: 520 } as const;

// Primary for what is said, secondary for what explains it, accent for a link's color.
export const Colors = () => (
  <div style={column}>
    <Text>Search runs in the browser over decrypted text.</Text>
    <Text color="secondary">Your agent checks it against the board, the code and the open pull requests.</Text>
    <Text color="accent">capstone#44 · draft</Text>
  </div>
);

// The label type names a thing, such as a card's id in its peek; semibold marks a heading in a row.
export const TypesAndWeights = () => (
  <div style={column}>
    <Text type="label" color="secondary">
      R-12
    </Text>
    <Text weight="semibold">Needs you</Text>
    <Text type="supporting">Started 14 min ago</Text>
    <Text type="code">npm install minisearch</Text>
  </div>
);
