import { RunAsk } from '@webchat/board-kit';

const answer = () => undefined;
const column = { width: 520 } as const;

// The agent asks to run a command; the text is plain, never Markdown.
export const Question = () => (
  <div style={column}>
    <RunAsk text="npm install minisearch" days={7} onAnswer={answer} />
  </div>
);

// Once the owner answered, the buttons are off until the agent says it settled.
export const Answered = () => (
  <div style={column}>
    <RunAsk text="Write outside the folder: ~/.npmrc" days={3} isDisabled onAnswer={answer} />
  </div>
);
