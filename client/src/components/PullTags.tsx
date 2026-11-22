import { Badge } from '@astryxdesign/core/Badge';
import type { PullCardDTO, PullChecks, PullReview, RunReport } from '../../../shared/types';

export type Tone = 'ok' | 'danger' | 'warn' | 'info' | 'muted';

const VARIANT = { ok: 'success', danger: 'error', warn: 'warning', info: 'info', muted: 'neutral' } as const;

export const Tag = ({ tone, children }: { tone: Tone; children: string }) => (
  <Badge variant={VARIANT[tone]} label={children} />
);

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
  note: ['info', 'Working…'],
  overlap: ['warn', 'Waiting for another card'],
};

const CHECKS: Record<NonNullable<PullChecks>, [Tone, string]> = {
  success: ['ok', 'Checks passed'],
  failure: ['danger', 'Checks failed'],
  pending: ['warn', 'Checks running'],
};

export const REVIEWS: Record<NonNullable<PullReview>, [Tone, string]> = {
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

/** The look of the pane's small stroked icons. */
export const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** A pull request's mark: Draft dashed, Ready solid, Merged as the merge icon. */
export function PullMark({ state }: { state: 'draft' | 'ready' | 'approved' | 'merged' }) {
  if (state === 'merged')
    return (
      <svg {...svg} width={16} height={16} className="pull-mark tone-ok">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </svg>
    );
  return (
    <svg
      {...svg}
      width={16}
      height={16}
      className={`pull-mark ${state === 'approved' ? 'tone-ok' : ''}`}
      strokeDasharray={state === 'draft' ? '3 2.5' : undefined}
    >
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M18 15V8a2 2 0 0 0-2-2h-5" />
      <polyline points="13 3 10 6 13 9" />
    </svg>
  );
}

/** A grey chip whose small icon carries the colour, so a lane of cards stays quiet. */
export function StateChip({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className="pull-chip">
      <svg {...svg} width={13} height={13} className={`tone-${tone}`}>
        {tone === 'ok' ? (
          <polyline points="5 12.5 10 17 19 7" />
        ) : tone === 'warn' ? (
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
        ) : (
          <>
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </>
        )}
      </svg>
      {children}
    </span>
  );
}

/** The chips of a pull request on the Pull requests pane: its checks, a requested change and conflicts. */
export function PullChips({ pull }: { pull: Pick<PullCardDTO, 'checks' | 'review' | 'conflicts'> }) {
  const checks = pull.checks && CHECKS[pull.checks];
  return (
    <>
      {checks && <StateChip tone={checks[0]}>{checks[1]}</StateChip>}
      {pull.review === 'changes_requested' && <StateChip tone="danger">Changes requested</StateChip>}
      {pull.conflicts && <StateChip tone="danger">Conflicts</StateChip>}
    </>
  );
}
