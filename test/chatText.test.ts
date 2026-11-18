import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { chatSpans, firstEmoji } from '../client/src/chatText.ts';

describe('Chat text styles in client/src/chatText.ts', () => {
  test('bold, italic and code spans split out of plain text', () => {
    assert.deepEqual(chatSpans('a **b** *c* `d` e'), [
      { style: 'plain', text: 'a ' },
      { style: 'bold', text: 'b' },
      { style: 'plain', text: ' ' },
      { style: 'italic', text: 'c' },
      { style: 'plain', text: ' ' },
      { style: 'code', text: 'd' },
      { style: 'plain', text: ' e' },
    ]);
  });

  test('a fenced block drops its language line and keeps its stars as typed', () => {
    assert.deepEqual(chatSpans('see\n```ts\nconst a = **b**;\n```\nok'), [
      { style: 'plain', text: 'see\n' },
      { style: 'block', text: 'const a = **b**;' },
      { style: 'plain', text: 'ok' },
    ]);
  });

  test('stars inside words or alone stay plain, as do headings, links and HTML', () => {
    for (const text of ['2*3*4', 'a*b* c', 'x**y** z', 'a * b * c', '# Heading', '[x](https://example.com)', '<b>hi</b>', '**not closed']) {
      assert.deepEqual(chatSpans(text), [{ style: 'plain', text }]);
    }
  });

  // Safari before 16.4 has no lookbehind. The build cannot rewrite a regex, so one in the page's
  // code throws when its module loads on iOS 15, and the page stays white (D-052).
  test('no client regex uses lookbehind', async () => {
    const dir = new URL('../client/src/', import.meta.url);
    for (const file of await readdir(dir, { recursive: true })) {
      if (!/\.tsx?$/.test(file)) continue;
      assert.doesNotMatch(await readFile(new URL(file, dir), 'utf8'), /\(\?<[=!]/, file);
    }
  });
});

describe('The first emoji typed into the reaction tray', () => {
  test('keeps a whole sequence: skin tone, family, flag', () => {
    assert.equal(firstEmoji('👍🏽'), '👍🏽');
    assert.equal(firstEmoji('ab👨‍👩‍👧x🎉'), '👨‍👩‍👧');
    assert.equal(firstEmoji('🇳🇱'), '🇳🇱');
  });

  test('is null for text with no emoji', () => {
    assert.equal(firstEmoji('hello'), null);
    assert.equal(firstEmoji(''), null);
  });
});
