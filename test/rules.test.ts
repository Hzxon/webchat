import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { MIGRATIONS } from '../server/db.ts';

// One SHA-256 per file under server/migrations/, in order, over the SQL without its comments and
// spacing, so a comment can change and the SQL cannot. A migration that has reached main never changes (D-010):
// each ran once on every database, so an edit, a reorder or a removal fails here. To accept a new
// migration, run the test and append the line it prints. Replace a line only for a migration that
// has not reached main yet.
const FROZEN_MIGRATIONS = [
  'd2372ecfb052c955a548a4885b3fc376c6d42eb156acf23de7545f7d0d8db304',
  'ea10acb5ed675abaa57915eaf12ee33b5150729dbebaa1e2062de045833f28b4',
  '793dabc798731dce29ee909323c95f6240c4f956277c379aa2d94fda3426cff7',
  'b06fdf91bea5e05f34fd45e08a2e20caee90dfacc6fbc3adc3c22faeec5301d3',
  '99c0f48cdbfc37275c063c69c532592692fbcb016933bc4f04adc485e48c4ae2',
  '638aa6201049b05fb106b7a58f96f83874f73b9be7f97e5d28596a3d474e61c9',
  'f030f55bb830d4fead56296bd8c643d3f7eebda60a631d26b738cc5aa435fa7e',
  'bc0b586b4e65c1bbb624a525c27ec381fc293c7e57913499d9c220429d871b80',
  '5902f958a5761c56c0397965e32bf33d598f524c7a13ede7d0c08ca63a8a0f83',
  'b4f68408bdf6636b89bca6c23feb7194e447e57d653c01087b9acb587c0d9e53',
  'ebd6a6d117634f4cd3007a3036e51e26e3af4aa5998d855099c7bb78b707569b',
  'd9a627afb1420268552cbd5f0b69cf1c53b38038b82ae9f12279c4217bc70e43',
  'add55d53e0efa55e539a6b4dc16e7e5530dbca77a63740a174887640aa0801bb',
  'f27790226eea1869dbba18b7db86a05ef5775475f09986a51e1d8e6ceab9c3a0',
  '1f04161d523a8ba3b95af84c6c5325e7a67d3641b0e2e17b7b17b9d934af82f8',
  '6780beadbac296baee0cd93b88657dc4f640d990c47361a09e013fdcc9d0098a',
  'b0d04e939a862e3bda3bcea5cc2894dc387d1dcefc473fa6b8d7f719f709f71a',
  'a80be24d085f7ed4abf275a2d1f85f5859d8baef7d6e8c5a032aca4747fc2de6',
  '39a9fd3cc11af2e86ff954abbaae35153f204f16f9f4a5ab6785e7e985011e9c',
  '0007912531947dcb728020a77515fd43d4624085e316b1de2b80bc21d714278d',
  '0a59618a3d71798ac6ecd6abc5910f32525fb96300e02348705a58714640973b',
  '7ee8f033cefa920fde1c10dd7280cd58b35202cc348a75d984208ad244e7cb44',
];

// The rules in AGENTS.md "Rules that must hold" that a test can state (D-091). The chat tests
// check rule 7, the push payload, and the GitHub tests check rule 8, the token.
describe('The rules that must hold', () => {
  test('rule 3: migrations only grow at the end (D-010)', () => {
    const sqlOf = (migration: string) => migration.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
    const hashes = MIGRATIONS.map((migration) => createHash('sha256').update(sqlOf(migration)).digest('hex'));
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
