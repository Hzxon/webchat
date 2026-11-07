import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BarkDTO } from '../shared/types.ts';
import { isOldIos } from '../client/src/ios.ts';

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module through its PushState import. tsx still loads it.
const alertSetup = '../client/src/alertSetup.ts';
const { alertsReady, pushWarning } = await import(alertSetup);

const ios15 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1';
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** The push state a browser with this user agent reports before notifications are allowed. */
const pushFor = (userAgent: string) => ({
  permission: isOldIos(userAgent) ? ('unsupported' as const) : ('default' as const),
  pushSupported: !isOldIos(userAgent),
  subscribed: false,
  endpoint: null,
  needsInstall: false,
  oldIos: isOldIos(userAgent),
});

const link = (phones: number): BarkDTO => ({
  configured: true,
  link: {
    serverUrl: 'https://chat.example/api/bark/token',
    cipherKey: null,
    devices: Array.from({ length: phones }, (_, i) => ({ key: `phone${i}`, registeredAt: 1, seenAt: 1 })),
  },
});

describe('The sidebar notification warning on iOS before 16.4 (K-1, D-054)', () => {
  test('an iOS 15 user agent with a Bark phone registered shows no warning', () => {
    const push = pushFor(ios15);
    assert.equal(push.oldIos, true);
    assert.equal(pushWarning(push, link(1)), null);
    assert.equal(alertsReady(push, link(1)), true);
  });

  test('an iOS 15 user agent without a link, or with a link and no phone, still shows it', () => {
    const push = pushFor(ios15);
    const warning = 'Notifications on iPhone need iOS 16.4. Tap to get alerts through the Bark app instead.';
    for (const bark of [undefined, null, { configured: true, link: null }, link(0)]) {
      assert.equal(pushWarning(push, bark), warning);
      assert.equal(alertsReady(push, bark), false);
    }
  });

  test('other browsers keep their warning even with a Bark phone registered', () => {
    const push = pushFor(desktop);
    assert.equal(pushWarning(push, link(1)), 'Turn on notifications so urgent messages reach you when this tab is closed.');
    assert.equal(pushWarning({ ...push, permission: 'granted' }, undefined), null);
  });
});
