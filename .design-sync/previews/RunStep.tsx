import { RunStep } from '@webchat/board-kit';

const column = { width: 480 } as const;

// The agent's message: a neutral mark at its side, and the time under it.
export const FromTheAgent = () => (
  <div style={column}>
    <RunStep time="12:41 AM">I am on R-12: Search in channels</RunStep>
  </div>
);

// The owner's own words carry the accent.
export const FromTheOwner = () => (
  <div style={column}>
    <RunStep time="12:40 AM" isMine>
      Run R-12: Search in channels
    </RunStep>
    <RunStep time="12:52 AM" isMine>
      Use the Postgres full-text index instead.
    </RunStep>
  </div>
);

// A failure carries the danger color.
export const Failure = () => (
  <div style={column}>
    <RunStep time="1:02 AM" isFailed>
      I could not run R-12: the tests fail in search.test.ts.
    </RunStep>
  </div>
);
