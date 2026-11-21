import { Button, PlayIcon } from '@webchat/board-kit';

const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } as const;
const act = () => undefined;

// One primary button on a surface; the rest stay quiet.
export const Variants = () => (
  <div style={row}>
    <Button variant="primary" label="Go" onClick={act} />
    <Button label="Mark ready" onClick={act} />
    <Button variant="ghost" label="Check again" onClick={act} />
    <Button variant="destructive" label="Delete card" onClick={act} />
  </div>
);

// Small on a card's face and in the peek, the default elsewhere.
export const Sizes = () => (
  <div style={row}>
    <Button size="sm" label="Pick" onClick={act} />
    <Button label="Start again" onClick={act} />
    <Button size="lg" label="Connect coding agent" onClick={act} />
  </div>
);

// Disabled with the reason as a tooltip, loading, and with an icon.
export const States = () => (
  <div style={row}>
    <Button size="sm" label="Send to review" isDisabled tooltip="An agent or a pull request runs it" onClick={act} />
    <Button label="Linking" isLoading onClick={act} />
    <Button label="Run with your agent" icon={<PlayIcon width={16} height={16} />} onClick={act} />
  </div>
);
