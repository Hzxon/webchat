import type { ReactNode } from 'react';
import type { PullCardDTO, PullChecks, PullReview, RunReport } from '../../../shared/types';

export type Tone = 'ok' | 'danger' | 'warn' | 'info' | 'muted';

export const Tag = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`tag tag-${tone}`}>{children}</span>;

/** An agent's latest report on a run, in the chat and on the board (R-027), in the pane's words (D-105). */
export const RUN_TAGS: Record<RunReport['kind'], [Tone, string]> = {
  claimed: ['info', 'Working…'],
  done: ['ok', 'Draft ready'],
  failed: ['danger', 'Couldn’t finish'],
  fixing: ['info', 'Fixing'],
  review: ['warn', 'Waiting for you'],
  ended: ['muted', 'Done'],
  nocopy: ['warn', 'Waiting for you'],
  stale: ['warn', 'No longer holds'],
  decision: ['warn', 'Waiting for a decision'],
  merged: ['ok', 'Merged'],
  closed: ['muted', 'Closed'],
  draft: ['ok', 'Draft ready'],
  progress: ['info', 'Working…'],
  paused: ['warn', 'Stopped'],
  planned: ['warn', 'Plan ready'],
};

const CHECKS: Record<NonNullable<PullChecks>, [Tone, string]> = {
  success: ['ok', 'Checks passed'],
  failure: ['danger', 'Checks failed'],
  pending: ['warn', 'Checks running'],
};

const REVIEWS: Record<NonNullable<PullReview>, [Tone, string]> = {
  approved: ['ok', 'Approved'],
  changes_requested: ['danger', 'Changes requested'],
  review_required: ['muted', 'Review required'],
};

/** The state tags of a pull request: draft, checks, review decision and conflicts. */
export function PullTags({ pull }: { pull: Pick<PullCardDTO, 'draft' | 'checks' | 'review' | 'conflicts'> }) {
  const checks = pull.checks && CHECKS[pull.checks];
  const review = pull.review && REVIEWS[pull.review];
  return (
    <>
      {pull.draft && <Tag tone="muted">Draft</Tag>}
      {checks && <Tag tone={checks[0]}>{checks[1]}</Tag>}
      {review && <Tag tone={review[0]}>{review[1]}</Tag>}
      {pull.conflicts && <Tag tone="danger">Conflicts</Tag>}
    </>
  );
}
