// A card's run as a panel beside its card (R-047): a heading with where the run stands, its messages
// as steps, and what the owner can do under them. The parts take plain values; AgentThread fills
// them from the owner's chat with their agent.
import type { ReactNode, Ref } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Text } from '@astryxdesign/core/Text';
import { Tag, type Tone } from './PullTags';

export function RunPanel({
  started,
  state,
  footer,
  listRef,
  children,
}: {
  /** When the run started, in words, such as "14 min ago". */
  started: string;
  /** Where the run stands, such as "Asking you" in the warning tone. */
  state: { tone: Tone; label: string };
  /** What the owner can do: a question, the plan's buttons, the box for their words. */
  footer?: ReactNode;
  /** The scrolling list, which its owner keeps at the newest step. */
  listRef?: Ref<HTMLDivElement>;
  /** The run's steps, oldest first, and a line for what it does now. */
  children: ReactNode;
}) {
  return (
    <>
      <header className="run-head">
        <Text weight="semibold">Run</Text>
        <Text color="secondary">Started {started}</Text>
        <Tag tone={state.tone}>{state.label}</Tag>
      </header>
      <div className="agents-session">
        <div className="messages is-panel" ref={listRef}>
          {children}
        </div>
      </div>
      {footer && <footer className="composer">{footer}</footer>}
    </>
  );
}

/** One message of a run, on a line of its own with a mark at its side: the accent for the owner's words, the danger color for a failure. */
export function RunStep({
  time,
  isMine,
  isFailed,
  children,
}: {
  /** When it was sent, such as "12:40 AM". */
  time: string;
  isMine?: boolean;
  isFailed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`run-step${isMine ? ' is-mine' : ''}${isFailed ? ' is-failed' : ''}`}>
      {children}
      <span className="run-step-time">{time}</span>
    </div>
  );
}

/** A question the agent asks before it acts, with the owner's three answers (docs/decisions/harness-approvals.md). */
export function RunAsk({
  text,
  days,
  isDisabled,
  onAnswer,
}: {
  /** What it asks to do, as plain text: a command can hide in Markdown. */
  text: string;
  /** The days left before the run ends unanswered. */
  days: number;
  isDisabled?: boolean;
  onAnswer: (decision: 'once' | 'run' | 'deny') => void;
}) {
  return (
    <div className="agents-dock">
      <Text as="p" weight="semibold">
        {text}
      </Text>
      <div className="agents-draft-actions">
        <Button variant="primary" label="Allow" isDisabled={isDisabled} onClick={() => onAnswer('once')} />
        <Button label="Allow for this run" isDisabled={isDisabled} onClick={() => onAnswer('run')} />
        <Button label="Deny" isDisabled={isDisabled} onClick={() => onAnswer('deny')} />
      </div>
      <Text as="p" color="secondary">
        It waits for you, and ends in {days} days if you do not answer.
      </Text>
    </div>
  );
}
