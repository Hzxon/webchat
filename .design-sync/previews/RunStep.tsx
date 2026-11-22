import { RunStep } from '@webchat/board-kit';

// Steps show as they do in the peek's run pane, which styles them.
const column = { display: 'flex', flexDirection: 'column', gap: 14, width: 400, padding: 16, background: 'var(--lane)' } as const;

// The agent's step: a check at its side, and its time at the right.
export const FromTheAgent = () => (
  <aside className="peek-run" style={column}>
    <RunStep time="12:41">Read the card, server/push.ts and its tests</RunStep>
  </aside>
);

// The owner's own words, as a bubble at the right.
export const FromTheOwner = () => (
  <aside className="peek-run" style={column}>
    <RunStep time="12:40" isMine>
      Run K-12: Drop bad push keys
    </RunStep>
  </aside>
);

// A failure carries the danger color.
export const Failure = () => (
  <aside className="peek-run" style={column}>
    <RunStep time="1:02" isFailed>
      I could not run K-12: the tests fail in push.test.ts.
    </RunStep>
  </aside>
);
