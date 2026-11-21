import {
  Avatar,
  Button,
  CardPeek,
  HistoryIcon,
  IconButton,
  Markdown,
  PencilIcon,
  RunAsk,
  RunPanel,
  RunStep,
  StopIcon,
  Tag,
  TrashIcon,
} from '@webchat/board-kit';

const act = () => undefined;
const BODY = `**Why:** a channel with 500 messages has no way to find an old decision.

**Scope:**

- Search runs in the browser over decrypted text.
- Nothing new reaches the server.

**Done when:** a word typed in the channel header lists matching messages, newest first.`;

const tools = (running: boolean) => (
  <>
    <IconButton variant="ghost" size="sm" label="Edit card" tooltip="Edit" icon={<PencilIcon width={18} height={18} />} onClick={act} />
    <IconButton variant="ghost" size="sm" label="Card history" tooltip="History" icon={<HistoryIcon width={18} height={18} />} onClick={act} />
    {running && <IconButton variant="ghost" size="sm" label="Stop the run" tooltip="Stop" icon={<StopIcon width={18} height={18} />} onClick={act} />}
    <IconButton variant="ghost" size="sm" label="Delete card" tooltip="Delete" icon={<TrashIcon width={18} height={18} />} onClick={act} />
  </>
);
const owner = (
  <>
    <Avatar name="Ann Lee" seed={1} size={20} /> Ann Lee
  </>
);

// A card with a run of the user's own: the card on the left, the run's panel on the right.
export const WithRun = () => (
  <CardPeek
    id="R-12"
    title="Search in channels"
    tools={tools(true)}
    facts={[
      ['Status', "Running: Ann's agent"],
      ['Owner', owner],
      ['Run', <Tag tone="warn">Asking you</Tag>],
      ['Runs it', "Ann's agent · Claude Code"],
      ['Repository', 'ann/capstone'],
      ['Pull request', <a href="https://github.com/ann/capstone/pull/44">ann/capstone#44</a>],
    ]}
    prev="r-11"
    next="r-13"
    onOpen={act}
    onClose={act}
    run={
      <RunPanel started="14 min ago" state={{ tone: 'warn', label: 'Asking you' }} footer={<RunAsk text="npm install minisearch" days={7} onAnswer={act} />}>
        <RunStep time="12:40 AM" isMine>
          Run R-12: Search in channels
        </RunStep>
        <RunStep time="12:41 AM">I am on R-12: Search in channels</RunStep>
        <RunStep time="12:43 AM">The card holds. I wrote the index and now add the search box to the channel header.</RunStep>
      </RunPanel>
    }
  >
    <Markdown text={BODY} />
  </CardPeek>
);

// A card with no run, as a teammate also sees it: one column, with the card's moves over its text.
export const CardOnly = () => (
  <CardPeek
    id="R-14"
    title="Export a chat as a file"
    tools={tools(false)}
    facts={[
      ['Status', 'Idea'],
      ['Owner', owner],
      ['Checked', <Tag tone="muted">Not checked by an agent yet</Tag>],
    ]}
    next="r-15"
    onOpen={act}
    onClose={act}
  >
    <p className="board-card-run">
      <Button size="sm" label="Mark ready" onClick={act} />
    </p>
    <Markdown text={`**Why:** a team that hands in its chat as an appendix copies it by hand today.\n\n**Done when:** a channel exports as one Markdown file.`} />
  </CardPeek>
);

// With no id the title stays in the header: a form or a draft takes the peek alone.
export const TitleOnly = () => (
  <CardPeek title="Bark banner for iOS 15" onOpen={act} onClose={act}>
    <Markdown text={`A new idea for the board.\n\n**Why:** an iPhone on iOS 15 gets no alert for an urgent message.\n\n**Done when:** the phone rings through Bark.`} />
    <p className="board-card-run">
      <Button variant="primary" label="Add as idea R-15" onClick={act} />
    </p>
  </CardPeek>
);
