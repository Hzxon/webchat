import { Banner } from '@webchat/board-kit';

const column = { display: 'grid', gap: 8, width: 520 } as const;

// The four statuses, with lines the board says.
export const Statuses = () => (
  <div style={column}>
    <Banner status="info" title="Go on with this plan, or tell it what to change." />
    <Banner status="warning" title="Another card has this number. Renumber one of them." />
    <Banner status="error" title="This card could not be saved. Try again." />
    <Banner status="success" title="Added as idea R-12." />
  </div>
);

// A title with a line under it.
export const WithDescription = () => (
  <div style={column}>
    <Banner status="warning" title="Bo set “Done”." description="Only Ann, who opened it, can do that." />
  </div>
);
