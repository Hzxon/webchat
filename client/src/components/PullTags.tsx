import type { ReactNode } from 'react';
import type { PullCardDTO, PullChecks, PullReview } from '../../../shared/types';

export type Tone = 'ok' | 'danger' | 'warn' | 'info' | 'muted';

export const Tag = ({ tone, children }: { tone: Tone; children: ReactNode }) => <span className={`tag tag-${tone}`}>{children}</span>;

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
