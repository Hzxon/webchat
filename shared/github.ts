// Wording for pull request events, shared by the server's pushes and the page's toasts and activity list.
import type { GithubEventDTO } from './types.js';

export function describeGithubEvent(event: Pick<GithubEventDTO, 'kind' | 'actor' | 'repo' | 'number' | 'title'>): {
  title: string;
  body: string;
} {
  const who = event.actor ?? 'Someone';
  const title = {
    review_requested: `${who} asked for your review`,
    approved: 'Your pull request was approved',
    changes_requested: 'Changes requested on your pull request',
    commented: `${who} commented on your pull request`,
    checks_failed: 'Checks failed on your pull request',
    checks_passed: 'Checks passed on your pull request',
    conflicts: 'Your pull request has merge conflicts',
    merged: event.actor ? `${event.actor} merged your pull request` : 'Your pull request was merged',
    closed: 'Your pull request was closed',
  }[event.kind];
  return { title, body: `${event.title} (${event.repo}#${event.number})` };
}
