// Wording for pull request events, shared by the server's pushes and the page's toasts and activity list.
import { readPull } from './e2ee.js';
import type { GithubCardDTO, GithubEventDTO, PullEvent } from './types.js';

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

const PULL_EVENTS = new Set<PullEvent>(['opened', 'ready', 'reopened', 'merged', 'closed']);
/** A GitHub login. Bots such as "dependabot[bot]" count too. */
const LOGIN = /^[^\s/]{1,100}$/;

const loginOf = (value: unknown) => (typeof value === 'string' && LOGIN.test(value) ? value : null);

/**
 * The card inside a message of kind "github", if it has the right shape. The server wrote it, so
 * nothing signs it; the link is still rebuilt, so it can only lead to that pull request on github.com.
 */
export function readGithubCard(body: string): GithubCardDTO | undefined {
  let raw: { event?: unknown; pull?: unknown; author?: unknown; actor?: unknown } | null;
  try {
    raw = JSON.parse(body) as typeof raw;
  } catch {
    return undefined;
  }
  const pull = readPull(raw?.pull as Parameters<typeof readPull>[0]);
  if (!raw || !pull || !PULL_EVENTS.has(raw.event as PullEvent)) return undefined;
  return { event: raw.event as PullEvent, pull, author: loginOf(raw.author), actor: loginOf(raw.actor) };
}

/** What happened, such as "octo opened a pull request". */
export function githubCardEvent(card: Pick<GithubCardDTO, 'event' | 'author' | 'actor'> & { pull: { draft: boolean } }): string {
  const actor = card.actor ?? 'Someone';
  return {
    opened: `${card.author ?? 'Someone'} opened a ${card.pull.draft ? 'draft ' : ''}pull request`,
    ready: `${actor} marked a pull request ready for review`,
    reopened: `${actor} reopened a pull request`,
    merged: `${actor} merged a pull request`,
    closed: `${actor} closed a pull request`,
  }[card.event];
}

/** The card in one line, for notifications, the chat list and the toasts. */
export const describeGithubCard = (card: GithubCardDTO) =>
  `${githubCardEvent(card)}: ${card.pull.title} (${card.pull.repo}#${card.pull.number})`;
