/** A piece of a chat message: plain text, or text in one of the few styles chat renders. */
export interface Span {
  style: 'plain' | 'bold' | 'italic' | 'code' | 'block';
  text: string;
}

// A fenced block, whose first line may name a language, then code spans, bold and italic. The block
// takes the line break after it, since it shows as a block already. Stars next to letters or
// digits stay plain, so 2*3*4 is not italic.
const CHAT = /```(?:[\w+-]*\n)?([\s\S]*?)\n?```\n?|`([^`\n]+)`|(?<![\w*])\*\*(?=\S)([\s\S]*?\S)\*\*(?![\w*])|(?<![\w*])\*(?=[^\s*])([^*\n]*?\S)\*(?![\w*])/g;

/**
 * Splits a chat message into the styles chat shows: a small subset of what docs render, with no
 * headings, lists, tables or images, so a message reads as it was typed. Styles do not nest.
 */
export function chatSpans(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(CHAT)) {
    const [whole, block, code, bold, italic] = match;
    if (match.index > last) out.push({ style: 'plain', text: text.slice(last, match.index) });
    if (block !== undefined) out.push({ style: 'block', text: block });
    else if (code !== undefined) out.push({ style: 'code', text: code });
    else if (bold !== undefined) out.push({ style: 'bold', text: bold });
    else out.push({ style: 'italic', text: italic! });
    last = match.index + whole.length;
  }
  if (last < text.length) out.push({ style: 'plain', text: text.slice(last) });
  return out;
}

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The first emoji in what the user typed, with its skin tone and joiners, or null if there is none. */
export function firstEmoji(typed: string): string | null {
  for (const { segment } of new Intl.Segmenter().segment(typed)) if (PICTOGRAPH.test(segment)) return segment;
  return null;
}
