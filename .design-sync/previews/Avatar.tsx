import { Avatar } from '@webchat/board-kit';

const row = { display: 'flex', gap: 12, alignItems: 'center' } as const;

// A person's initials on the color their number picks; the same person keeps the same color.
export const People = () => (
  <div style={row}>
    <Avatar name="Ann Lee" seed={1} />
    <Avatar name="Bo Tan" seed={2} />
    <Avatar name="Cy Moreno" seed={5} />
    <Avatar name="Dee" seed={7} />
  </div>
);

// The sizes the board uses: 20 for a reviewer or a fact, 24 on a card's face, 44 in a list.
export const Sizes = () => (
  <div style={row}>
    <Avatar name="Ann Lee" seed={1} size={20} />
    <Avatar name="Ann Lee" seed={1} size={24} />
    <Avatar name="Ann Lee" seed={1} size={44} />
  </div>
);

// Online, and square for a project.
export const OnlineAndSquare = () => (
  <div style={row}>
    <Avatar name="Ann Lee" seed={1} online />
    <Avatar name="Capstone" seed={4} square />
  </div>
);
