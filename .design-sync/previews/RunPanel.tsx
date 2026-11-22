import { Banner, Button, RunAsk, RunPanel, RunStep } from '@webchat/board-kit';

// The panel fills a column that gives it a height, as the peek's right pane does; that pane styles it.
const column = { display: 'flex', flexDirection: 'column', width: 420, height: 480, background: 'var(--lane)' } as const;
const answer = () => undefined;

const start = (
  <>
    <RunStep time="12:40 AM" isMine>
      Run R-12: Search in channels
    </RunStep>
    <RunStep time="12:41 AM">I am on R-12: Search in channels</RunStep>
  </>
);

// The agent asks before it runs a command; the question waits under the steps.
export const AskingYou = () => (
  <aside className="peek-run" style={column}>
    <RunPanel
      started="14 min ago"
      footer={<RunAsk text="npm install minisearch" days={7} onAnswer={answer} />}
    >
      {start}
      <RunStep time="12:43 AM">The card holds. I wrote the index and now add the search box to the channel header.</RunStep>
    </RunPanel>
  </aside>
);

// A plan waits for the owner's go.
export const PlanReady = () => (
  <aside className="peek-run" style={column}>
    <RunPanel
      started="2 min ago"
      footer={
        <div className="agents-ended">
          <Banner status="info" title="Go on with this plan, or tell it what to change." />
          <Button variant="primary" label="Go" onClick={answer} />
          <Button label="Stop" onClick={answer} />
        </div>
      }
    >
      {start}
      <RunStep time="12:42 AM">
        R-12 holds. My plan: add an index built in the browser, then a search box in the channel header, then tests for both. Say go, or
        tell me what to change.
      </RunStep>
    </RunPanel>
  </aside>
);

// A run that stopped before a draft was ready: the failure carries the danger mark.
export const Failed = () => (
  <aside className="peek-run" style={column}>
    <RunPanel
      started="1 h ago"
      footer={
        <div className="agents-ended">
          <Banner status="info" title="It stopped before a draft was ready." />
          <Button label="Start again" onClick={answer} />
        </div>
      }
    >
      {start}
      <RunStep time="1:02 AM" isFailed>
        I could not run R-12: the tests fail in search.test.ts, and I found no fix that keeps the old results.
      </RunStep>
    </RunPanel>
  </aside>
);
