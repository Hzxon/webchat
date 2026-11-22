// A card's run as a panel beside its card (R-047): a heading with whose agent runs it and when it
// started, its messages as steps, and the agent's question pinned under them. The parts take plain
// values; AgentThread fills them from the owner's chat with their agent.
import { createContext, useContext, type ReactNode, type Ref } from 'react';
import { LaneIcon } from './BoardParts';
import type { Tone } from './PullTags';

/** The agent's name for the panel's heading, such as "Ann’s agent", which the board knows and AgentThread does not. */
export const RunAgent = createContext('Your agent');

export function RunPanel({
  started,
  footer,
  listRef,
  children,
}: {
  /** When the run started, in words, such as "14 min ago". */
  started: string;
  /** Where the run stands. The card's facts show it, so the panel does not. */
  state?: { tone: Tone; label: string };
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
        <strong>{useContext(RunAgent)}</strong>
        <span>Started {started}</span>
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

/** One message of a run: the owner's words as a bubble at the right, the agent's as a step with a mark and its time. */
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
  if (isMine)
    return (
      <div className="run-step is-mine" title={time}>
        {children}
      </div>
    );
  return (
    <div className={`run-step${isFailed ? ' is-failed' : ''}`}>
      <span className="run-step-mark">
        <LaneIcon kind={isFailed ? 'dropped' : 'done'} />
      </span>
      <div className="run-step-body">{children}</div>
      <time className="run-step-time">{time}</time>
    </div>
  );
}

const ANSWERS = [
  ['once', 'Allow'],
  ['run', 'Allow for this run'],
  ['deny', 'Deny'],
] as const;

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
    <div className="run-ask">
      <p>{text}</p>
      <div className="run-ask-answers">
        {ANSWERS.map(([decision, label]) => (
          <button key={decision} type="button" className="board-small-button" disabled={isDisabled} onClick={() => onAnswer(decision)}>
            {label}
          </button>
        ))}
      </div>
      <small>It waits for you, and ends in {days} days if you do not answer.</small>
    </div>
  );
}
