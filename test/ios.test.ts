import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iosVersion } from '../client/src/ios.ts';

const iphone = (os: string, safari: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safari} Mobile/15E148 Safari/604.1`;

test('reads the iOS version from an iPhone user agent', () => {
  assert.equal(iosVersion(iphone('15_8', '15.6.6')), 15.8);
  assert.equal(iosVersion(iphone('16_3', '16.3')), 16.3);
  assert.equal(iosVersion(iphone('16_4_1', '16.4')), 16.4);
  assert.equal(iosVersion(iphone('17_0', '17.0')), 17);
});

test('reads the iOS version from an iPad and from Chrome on iOS', () => {
  assert.equal(
    iosVersion(
      'Mozilla/5.0 (iPad; CPU OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
    ),
    16.3,
  );
  assert.equal(
    iosVersion(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
    ),
    15.8,
  );
});

test('returns null for a desktop browser, and for an iPad that reports itself as a Mac', () => {
  assert.equal(
    iosVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
    null,
  );
  assert.equal(
    iosVersion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15'),
    null,
  );
});
