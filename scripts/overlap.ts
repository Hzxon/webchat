// Fails a pull request that changes a file which an open pull request with a lower number also
// changes (docs/decisions/new-overlap-blocks.md). The workflow overlap.yml runs it:
//   gh pr list --state open --json number,headRefName,body,files --limit 200 | node scripts/overlap.ts 12
// The list is read from stdin, so a test runs it on fixture data without calling GitHub. The
// comparison is in shared/overlap.ts, which the owner's agent runs too.
import { fileURLToPath } from 'node:url';
import { overlaps, type Pull } from '../shared/overlap.ts';

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
