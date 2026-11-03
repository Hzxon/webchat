// Shows a doc's Markdown as React elements, never as HTML: other members write the text, and the
// Content Security Policy is strict (D-009). It covers what specs and reports use: headings,
// paragraphs, lists with checkboxes, quotes, code, tables and rules, with bold, italic, struck-out
// text, code and links. Underscores stay plain, because names like snake_case are common in specs.
import { Fragment, memo, type ReactNode } from 'react';
import { linkify } from './format';

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

// Memoized: an open doc renders again on every check-in that changes anything, and most of its sections did not.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text.replace(/\r\n?/g, '\n').split('\n'))}</div>;
});

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = out.length;
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);
    if (!line.trim()) {
      i++;
    } else if (fence) {
      let end = i + 1;
      while (end < lines.length && !lines[end]!.trim().startsWith(fence[1]!)) end++;
      out.push(
        <pre key={key}>
          <code>{lines.slice(i + 1, end).join('\n')}</code>
        </pre>,
      );
      i = end + 1;
    } else if (heading) {
      const Tag = `h${heading[1]!.length}` as 'h1';
      out.push(<Tag key={key}>{inline(heading[2]!)}</Tag>);
      i++;
    } else if (RULE.test(line)) {
      out.push(<hr key={key} />);
      i++;
    } else if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key}>{blocks(quoted)}</blockquote>);
    } else if (LIST_ITEM.test(line)) {
      const [list, next] = listAt(lines, i, key);
      out.push(list);
      i = next;
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|')) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key} className="markdown-table">
          <table>
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={c}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, c) => (
                    <td key={c}>{inline(row[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else {
      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) paragraph.push(lines[i++]!);
      out.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
    }
  }
  return out;
}

/** The list that starts at line `start`, and the line after it. Lines indented under an item belong to it. */
function listAt(lines: string[], start: number, key: number): [ReactNode, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const sameList = (line: string) => {
    const item = LIST_ITEM.exec(line);
    return item !== null && item[1]!.length === indent && /\d/.test(item[2]!) === ordered;
  };
  const indented = (line: string) => line.trim() !== '' && line.length - line.trimStart().length > indent;
  const items: Array<{ text: string; children: string[] }> = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (sameList(line)) {
      items.push({ text: LIST_ITEM.exec(line)![3]!, children: [] });
    } else if (indented(line)) {
      items.at(-1)!.children.push(line);
    } else if (line.trim() || !(sameList(lines[i + 1] ?? '') || indented(lines[i + 1] ?? ''))) {
      break;
    }
    i++;
  }
  const rendered = items.map((item, n) => {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
    // Children keep their indentation relative to one another, so a list inside a list nests again.
    const depth = Math.min(...item.children.map((c) => c.length - c.trimStart().length));
    return (
      <li key={n} className={task ? 'task' : undefined}>
        {task ? (
          <>
            <input type="checkbox" checked={task[1] !== ' '} disabled aria-label={task[1] !== ' ' ? 'Done' : 'Not done'} />{' '}
            {inline(task[2]!)}
          </>
        ) : (
          inline(item.text)
        )}
        {item.children.length > 0 && blocks(item.children.map((c) => c.slice(depth)))}
      </li>
    );
  });
  const list = ordered ? (
    <ol key={key} start={parseInt(first[2]!, 10)}>
      {rendered}
    </ol>
  ) : (
    <ul key={key}>{rendered}</ul>
  );
  return [list, i];
}

// Code spans, then links, bold, italic and struck-out text. Each group pair is one of them.
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=\S)([\s\S]*?\S)\*|~~(?=\S)([\s\S]*?\S)~~/g;
const SAFE_URL = /^(https?:|mailto:)/i;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const plain = (part: string) =>
    out.push(
      <Fragment key={out.length}>
        {part.split('\n').map((line, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {linkify(line)}
          </Fragment>
        ))}
      </Fragment>,
    );
  for (const match of text.matchAll(INLINE)) {
    const [whole, , code, label, url, bold, italic, struck] = match;
    if (match.index > last) plain(text.slice(last, match.index));
    const key = out.length;
    if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (label !== undefined && SAFE_URL.test(url!)) {
      out.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer">
          {inline(label)}
        </a>,
      );
    } else if (label !== undefined) plain(whole);
    else if (bold !== undefined) out.push(<strong key={key}>{inline(bold)}</strong>);
    else if (italic !== undefined) out.push(<em key={key}>{inline(italic)}</em>);
    else out.push(<del key={key}>{inline(struck!)}</del>);
    last = match.index + whole.length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}
