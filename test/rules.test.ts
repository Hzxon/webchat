import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { MIGRATIONS } from '../server/db.ts';

// One SHA-256 per entry of MIGRATIONS in server/db.ts, in order. A migration that has reached
// main never changes (D-010): each ran once on every database, so an edit, a reorder or a
// removal fails here. To accept a new migration, run the test and append the line it prints.
// Replace a line only for a migration that has not reached main yet.
const FROZEN_MIGRATIONS = [
  '834e58c84904c809613318646275e7171cbb8beb3aaeb1359a6caa863aee5657',
  '0cc6f23a6d4fa1780c7908e119297592be7fc89d2dbe82a5cf9f199ca1cde0d1',
  '42917fe8b1e8df7285e9b5f0abfd99a04e24079ed3a3454a5bb9a1ba3961ee7d',
  'b25cf1a73c9b20ea52a26f531519e10e00fd9845f3c210d61c2bf2efb61d53ce',
  '4b4739d82f5111e92ec22a0c9137a7baadabab89e3dcc833788b9ff4c3a27d4c',
  'b44457a1ea668d11301664fd56833edd10ea69ce3f613e6d322d6eb02df183d1',
  '78451749d88039fa2d71075aaff95e7ca0486b48f09c8c616ab29001d1458b76',
  'adb454b4d585b1c8794a7efa42e9a281c3a31d084c48bacb119b9c29acba1346',
  '3873c3eaf909dfbfedfbae2992cc9e3f62adb3d70f87f5c840d6be543c8a6953',
  '344302324a3ad63f53ebdb795f2376b69e3b0eeca17c6050ee41d39e9383d047',
  '3b8d2b153e9d40b09e722e05cb4fe679d2416f046606499dea8e7ce34bf1a33f',
  'f919ae85b095698d42af56eeedc16ba1ea593874bc8f46e2668218da1e1db816',
  '215f34b0d42c414f92d5b9c02bb00b22dd0b2e4932a330638fd5ba2f286b2e52',
  '0ebd90899e4c895c72d8f82eb7b7c0c4726a61a184675959817adbf0a201f68e',
  'c34dad80b0342014d7aa679c6969d5739475ad8675ef2e59b45c4260eba06d4c',
  '35310df21c9c5bf5c5dc0da6b875a4d83084ad1f96bcf5a273db58e82ee86624',
];

// The rules in AGENTS.md "Rules that must hold" that a test can state (D-091). The chat tests
// check rule 7, the push payload, and the GitHub tests check rule 8, the token.
describe('The rules that must hold', () => {
  test('rule 3: migrations only grow at the end (D-010)', () => {
    const hashes = MIGRATIONS.map((migration) => createHash('sha256').update(migration).digest('hex'));
    assert.ok(hashes.length >= FROZEN_MIGRATIONS.length, 'A migration was removed. A migration that reached main stays.');
    FROZEN_MIGRATIONS.forEach((frozen, i) => {
      assert.equal(
        hashes[i],
        frozen,
        `Migration ${i + 1} changed or moved. A migration that reached main never changes: add a new one at the end. ` +
          `If it has not reached main yet, replace line ${i + 1} of FROZEN_MIGRATIONS in test/rules.test.ts with '${hashes[i]}'.`,
      );
    });
    assert.equal(
      hashes.length,
      FROZEN_MIGRATIONS.length,
      `Migration ${FROZEN_MIGRATIONS.length + 1} is new. Append to FROZEN_MIGRATIONS in test/rules.test.ts: '${hashes[FROZEN_MIGRATIONS.length]}',`,
    );
  });

  test('rule 6: query strings are read with the WHATWG URL API, never req.query (D-012)', async () => {
    const hits: string[] = [];
    for (const dir of ['server', 'api']) {
      const root = new URL(`../${dir}/`, import.meta.url);
      for (const name of (await readdir(root)).filter((n) => n.endsWith('.ts'))) {
        const lines = (await readFile(new URL(name, root), 'utf8')).split('\n');
        lines.forEach((line, i) => {
          // Comments may say "req.query" to explain why it is not used.
          if (/\breq\.query\b/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) hits.push(`${dir}/${name}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(hits, [], 'reads req.query; use queryOf or the WHATWG URL API (D-012)');
  });
});
