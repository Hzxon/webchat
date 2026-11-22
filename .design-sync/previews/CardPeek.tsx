import { Avatar, Button, CardPeek, HistoryIcon, Markdown, RunAsk, RunPanel, RunStep, StateChip, TrashIcon } from '@webchat/board-kit';

const act = () => undefined;
const BODY = `**Why:** a push key that the push service rejects stays in the database. Every new message tries it again and logs an error.

**Scope:**

- Drop a key when the push service answers 410 Gone.
- Keep it on any other error, so a short outage keeps every key.

**Done when:** a 410 removes the key, and the next message sends no push to it.`;

const tools = [
  { label: 'History', icon: <HistoryIcon width={18} height={18} />, onClick: act },
  { label: 'Delete card', icon: <TrashIcon width={18} height={18} />, onClick: act },
];
const owner = (
  <>
    <Avatar name="Ann Lee" seed={1} size={20} /> Ann Lee
  </>
);

// The card on the left, under its Preview and Edit switch; on the right, the agent's run with its
// question pinned at the foot. At phone width the run goes under the card and the tools behind ⋯.
export const WithRun = () => (
  <CardPeek
    id="K-12"
    title="Drop bad push keys"
    tools={tools}
    facts={[
      ['Status', 'Running: Ann’s agent'],
      ['Owner', owner],
      ['Run', <StateChip chip={{ tone: 'warn', label: 'Asking you' }} />],
      ['Runs it', 'Ann’s agent · Claude Code'],
      ['Repository', 'webchat'],
    ]}
    onClose={act}
    isEditing={false}
    onEditing={act}
    run={
      <RunPanel started="14 min ago" footer={<RunAsk text="npm install web-push@3.6" days={7} onAnswer={act} />}>
        <RunStep time="12:40" isMine>
          Run K-12: Drop bad push keys
        </RunStep>
        <RunStep time="12:41">Read the card, server/push.ts and its tests</RunStep>
        <RunStep time="12:43">Wrote a test: a 410 drops the key</RunStep>
      </RunPanel>
    }
  >
    <Markdown text={BODY} />
  </CardPeek>
);

// A card with no run: the right pane says so, and offers to start one where the user may.
export const NoRun = () => (
  <CardPeek
    id="R-40"
    title="Export a chat as a file"
    tools={tools}
    facts={[
      ['Status', 'Ready'],
      ['Owner', owner],
      ['Checked', <StateChip chip={{ tone: 'muted', label: 'Not checked by an agent yet' }} />],
    ]}
    onClose={act}
    isEditing={false}
    onEditing={act}
    onRun={act}
  >
    <Markdown text={`**Why:** a team that hands in its chat as an appendix copies it by hand today.\n\n**Done when:** a channel exports as one Markdown file.`} />
  </CardPeek>
);

// With no id the title stays in the header, as for a draft that is not a card yet. Its switch is
// off, with the reason as its tooltip.
export const Draft = () => (
  <CardPeek title="Bark banner for iOS 15" onClose={act} isEditing={false} editOff="Add it to the board to edit it">
    <Markdown text={`A new idea for the board.\n\n**Why:** an iPhone on iOS 15 gets no alert for an urgent message.\n\n**Done when:** the phone rings through Bark.`} />
    <p className="board-card-run">
      <Button variant="primary" label="Add as idea R-15" onClick={act} />
    </p>
  </CardPeek>
);
