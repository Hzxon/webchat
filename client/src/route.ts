import type { State } from './store';

/**
 * A view that takes the landing pane's place, as the address hash names it. The hash never reaches
 * the server, so a link names nothing the server could log (rule 1, rule 6).
 */
export type Route =
  | { kind: 'chat'; id: number }
  | { kind: 'doc'; id: string }
  | { kind: 'board'; id: number }
  | { kind: 'agents'; thread: string | null }
  | { kind: 'github' };

const ID = /^[1-9]\d*$/;

/** The route a hash such as `#/chat/12` names, or null for the landing pane and anything else. */
export function parseRoute(hash: string): Route | null {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  } catch {
    // A hand-edited hash can hold a broken escape.
    return null;
  }
  const [kind, value, ...extra] = parts;
  if (extra.length > 0) return null;
  if ((kind === 'chat' || kind === 'board') && value && ID.test(value)) return { kind, id: Number(value) };
  if (kind === 'doc' && value) return { kind, id: value };
  if (kind === 'agents') return { kind, thread: value || null };
  if (kind === 'github' && value === undefined) return { kind };
  return null;
}

export function formatRoute(route: Route | null): string {
  if (!route) return '';
  if (route.kind === 'github') return '#/github';
  if (route.kind === 'agents') return route.thread ? `#/agents/${encodeURIComponent(route.thread)}` : '#/agents';
  return `#/${route.kind}/${encodeURIComponent(route.id)}`;
}

/** The view the page shows, in the order ChatLayout picks its pane. */
export function routeOf(s: Pick<State, 'githubOpen' | 'agentsOpen' | 'agentThread' | 'docOpen' | 'boardOpen' | 'activeId'>): Route | null {
  if (s.githubOpen) return { kind: 'github' };
  if (s.agentsOpen) return { kind: 'agents', thread: s.agentThread };
  if (s.docOpen) return { kind: 'doc', id: s.docOpen };
  if (s.boardOpen !== null) return { kind: 'board', id: s.boardOpen };
  return s.activeId === null ? null : { kind: 'chat', id: s.activeId };
}
