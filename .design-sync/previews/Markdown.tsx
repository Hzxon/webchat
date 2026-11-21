import { Markdown } from '@webchat/board-kit';

const column = { width: 560 } as const;

// A card's text: a card is Markdown, with its fields as lines that start with a bold word.
export const CardText = () => (
  <div style={column}>
    <Markdown
      text={`**Why:** a channel with 500 messages has no way to find an old decision.

**Scope:**

- Search runs in the browser over decrypted text.
- Nothing new reaches the server.

**Done when:** a word typed in the channel header lists matching messages, newest first.`}
    />
  </div>
);

// An agent's answer: headings, code, a link and a task list.
export const AgentAnswer = () => (
  <div style={column}>
    <Markdown
      text={`## The index

The index is built in \`client/src/search.ts\`, once per channel:

\`\`\`
npm run build
npm test
\`\`\`

- [x] Build the index
- [ ] Add the search box

See https://github.com/ann/capstone/pull/44 for the draft.`}
    />
  </div>
);
