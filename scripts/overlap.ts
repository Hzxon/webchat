// Fails a pull request that changes a file which an open pull request with a lower number also
// changes (docs/decisions/new-overlap-blocks.md). The workflow overlap.yml runs it:
//   gh pr list --state open --json number,headRefName,body,files --limit 200 | node scripts/overlap.ts 12
// The list is read from stdin, so a test runs it on fixture data without calling GitHub.
import { fileURLToPath } from 'node:url';

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const number = Number(process.argv[2]);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const open: Pull[] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const pull = open.find((candidate) => candidate.number === number);
  if (!pull) {
    console.error(`::error::Pull request #${number} is not in the list of open pull requests.`);
    process.exit(1);
  }
  const found = overlaps(pull, open);
  for (const { number: other, files } of found) {
    console.error(
      `::error::#${pull.number} and the earlier #${other} both change ${files.join(', ')}. ` +
        `Wait for #${other} to merge, or write "After #${other}" or "Stacked on #${other}" in this pull request's body once you and its author have agreed the order.`,
    );
  }
  if (found.length === 0) console.log(`#${pull.number} shares no file with an earlier open pull request.`);
  process.exit(found.length > 0 ? 1 : 0);
}
