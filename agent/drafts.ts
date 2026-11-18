import { LIMITS, type CardDraftDTO } from '../shared/types.ts';
import { type Conversation } from './conversations.ts';

/** A value the model gave, as one line of at most `max` characters, or '' when it is no text. */
/** A value as one line of at most `max` characters, or '' when it is no string. */
export const line = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The drafts in a turn's answer that have the right shape, as `draftOf` reads each. */
export function draftsOf(raw: unknown, seen: NonNullable<Conversation['seen']>, held: Set<string>) {
  const drafts: CardDraftDTO[] = [];
  for (const r of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
    const draft = draftOf(r, seen, held);
    if (!draft) continue;
    // A split's second card names a new card drafted before it, whose number it waits for (docs/roadmap/new-after-edge.md).
    const after = line(r?.after, LIMITS.docTitleLength);
    drafts.push(!draft.replaces && after && drafts.some((d) => !d.replaces && d.kind !== 'D' && d.title === after) ? { ...draft, after } : draft);
  }
  return drafts;
}

/**
 * A draft in a turn's answer, if it has the right shape (D-104). A change names a card or decision
 * the brief held, with the hash of its text there; a draft naming another becomes a new one. It
 * keeps only related ids the brief held: cards, decisions and open pull requests (D-116).
 */
export function draftOf(raw: Record<string, unknown> | undefined, seen: NonNullable<Conversation['seen']>, held: Set<string>): CardDraftDTO | undefined {
  const title = line(raw?.title, LIMITS.docTitleLength);
  const asked = raw?.kind === 'idea' ? 'R' : raw?.kind === 'issue' ? 'K' : raw?.kind === 'decision' ? 'D' : undefined;
  if (!raw || !asked || !title || typeof raw.body !== 'string') return;
  const replaced = typeof raw.replaces === 'string' ? raw.replaces.trim() : '';
  const card = seen[replaced];
  // A change keeps its card's own kind.
  const kind = card ? (replaced[0] as CardDraftDTO['kind']) : asked;
  // A card's limit, not a message's: each draft is a message of its own, sized for a full card.
  const body = raw.body.trim().slice(0, LIMITS.docSectionLength);
  const checked = line(raw.checked, LIMITS.checkedLength);
  const related = (Array.isArray(raw.related) ? raw.related : []).flatMap((r) => {
    const id = line(r?.id, 16);
    return held.has(id) && (r.kind === 'duplicate' || r.kind === 'conflict') ? [{ id, kind: r.kind as 'duplicate' | 'conflict', why: line(r.why, LIMITS.relatedWhyLength) }] : [];
  });
  return {
    kind,
    title,
    body,
    ...(card && { replaces: { card: replaced, doc: card.doc, section: card.section, seen: card.hash } }),
    ...(checked && { checked }),
    ...(related.length && { related: related.slice(0, LIMITS.relatedPerDraft) }),
  };
}
