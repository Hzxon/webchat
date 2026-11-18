// Two runs never hold the same file at once (docs/decisions/new-overlap-blocks.md). The `overlap`
// workflow runs this comparison through scripts/overlap.ts, and the owner's agent runs it before a
// card's work starts and before each push, so a draft the agent opens and one `scripts/claim.sh`
// opens are compared alike.
import type { Word } from './board.js';

export interface Pull {
  number: number;
  headRefName: string;
  body?: string | null;
  files?: { path: string }[];
}

// The board copy's pull request and Release Please's never count, on either side.
const exemptBranch = (branch: string) => branch === 'agent/board' || branch.startsWith('release-please--');
// A card or a decision file is a proposal, not a change to shared code.
const exemptFile = (file: string) => file.startsWith('docs/roadmap/') || file.startsWith('docs/decisions/');

/** The files and folders on a `Touches:` line, separated by commas or spaces. A folder ends in `/`. */
export function touches(body: string): string[] {
  const line = /^Touches:(.*)$/im.exec(body)?.[1] ?? '';
  return line.split(/[\s,]+/).map((path) => path.replaceAll('`', '')).filter(Boolean);
}

/** What a pull request holds: the files it changes, or for a draft with no diff yet, its `Touches:` line. */
export function footprint(pull: Pull): string[] {
  const changed = (pull.files ?? []).map((file) => file.path);
  return (changed.length > 0 ? changed : touches(pull.body ?? '')).filter((file) => !exemptFile(file));
}

/** The line a stacked draft's body carries, which `named` reads. */
export const stackedLine = (number: number) => `Stacked on #${number}`;

/** The pull requests the author named with `After #12` or `Stacked on #12`. */
export function named(body: string): number[] {
  return [...body.matchAll(/\b(?:after|stacked on) #(\d+)/gi)].map((match) => Number(match[1]));
}

/** The shared path of two entries, or undefined: equal, or one is a folder holding the other. */
function shared(a: string, b: string): string | undefined {
  if (a === b || (a.endsWith('/') && b.startsWith(a))) return b;
  if (b.endsWith('/') && a.startsWith(b)) return a;
  return undefined;
}

/** For each lower-numbered open pull request that the author did not name, the files it shares with this one. */
export function overlaps(pull: Pull, open: Pull[]): { number: number; files: string[] }[] {
  if (exemptBranch(pull.headRefName)) return [];
  const agreed = named(pull.body ?? '');
  const mine = footprint(pull);
  const found = [];
  for (const other of open) {
    if (other.number >= pull.number || exemptBranch(other.headRefName) || agreed.includes(other.number)) continue;
    const files = new Set<string>();
    for (const a of mine) for (const b of footprint(other)) {
      const path = shared(a, b);
      if (path) files.add(path);
    }
    if (files.size > 0) found.push({ number: other.number, files: [...files].sort() });
  }
  return found;
}

export type Choice = 'wait' | 'stack' | 'fold';

/** Who chooses for a card that waits for another: each card's owner, or for a card with none, whoever asked for its run. */
export const choosers = (owner: number | undefined, other: number | undefined, requester: number) => [...new Set([owner ?? requester, ...(other === undefined ? [] : [other])])];

/** A card's id with its number unpadded, such as K-5 for K-005, as ids from the page and from GitHub compare. */
export const cardKey = (id: string) => id.replace(/-0+(?=\d)/, '-');

/** The line a card owner writes on a waiting card, such as `Overlap with K-12: stack`. */
export const choiceLine = (waits: string, choice: Choice) => `Overlap with ${waits}: ${choice}`;

const CHOICE = /^Overlap with (\S+): (wait|stack|fold)\s*$/i;

/** The card a waiting card's status waits for, such as K-12 in `Waiting for K-12: Ann and Bo choose`; none for a decision. */
export const waitsOn = (status: string) => /^Waiting for ([RKQ]-\d+|#\d+):/.exec(status)?.[1];

/** The choice a card's text holds for the card it waits for: its last such line. */
export function lineChoice(text: string, waits: string): Choice | undefined {
  for (const line of text.split('\n').reverse()) {
    const found = CHOICE.exec(line.trim());
    if (found?.[1] === waits) return found[2]!.toLowerCase() as Choice;
  }
}

/** A card's text with an owner's choice as its last line, in place of any choice line it had. */
export const withChoice = (text: string, waits: string, choice: Choice) =>
  `${text
    .split('\n')
    .filter((line) => !CHOICE.test(line.trim()))
    .join('\n')
    .trimEnd()}\n\n${choiceLine(waits, choice)}`;

/**
 * What the two card owners chose for a card that waits for `waits`: the last such line of the newest
 * word of either that holds one, and only a word written after the wait began, so a line left from an
 * earlier wait does not count. The agent never chooses; a word is a revision its author signed (D-081).
 */
export function choiceOf(words: Word[], owners: number[], waits: string, since: number): Choice | undefined {
  for (const word of words) {
    const choice = word.id > since && owners.includes(word.authorId) ? lineChoice(word.text, waits) : undefined;
    if (choice) return choice;
  }
}
